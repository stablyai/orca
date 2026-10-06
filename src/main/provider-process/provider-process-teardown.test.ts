import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { DescendantSnapshot, ProcessTableRow } from '../pty-descendant-termination'
import { terminateProviderProcessTree } from './provider-process-teardown'

/** Above pid_max on every supported POSIX host, so the group signal is a real ESRCH. */
const UNREACHABLE_PGID = 2_147_483_647

function child() {
  return {
    pid: 1234,
    kill: vi.fn<ChildProcess['kill']>(() => true)
  }
}

function row(pid: number, ppid: number, pgid: number): ProcessTableRow {
  return { pid, ppid, pgid, startedAt: 'Mon Oct  5 10:00:00 2026' }
}

/** A paused supervisor's walk: its provider (pid 1235) leads a group of its own. */
function supervisorWalk(provider = 1235): DescendantSnapshot {
  return {
    root: { pid: 1234, startedAt: 'Mon Oct  5 09:59:00 2026' },
    rootPgid: 1234,
    descendants: [row(provider, 1234, provider)],
    capturedAtMs: 1
  }
}

function signals(target: ReturnType<typeof child>): unknown[] {
  return target.kill.mock.calls.map(([signal]) => signal)
}

describe('terminateProviderProcessTree', () => {
  beforeEach(() => {
    resetSelfInitiatedTreeKillLogForTest()
  })

  it('waits for the Windows tree kill, then reports the root kill as the provider kill', async () => {
    const target = child()
    const release = Promise.withResolvers<void>()
    const terminateWindowsTree = vi.fn(() => release.promise)

    const teardown = terminateProviderProcessTree(target, {
      site: 'codex-app-server-teardown',
      platform: 'win32',
      terminateWindowsTree
    })
    expect(target.kill).not.toHaveBeenCalled()
    release.resolve()
    // taskkill resolves alike on success, failure and timeout; TerminateProcess of the root is
    // the provider's own kill, since Windows runs it without a supervisor.
    await expect(teardown).resolves.toEqual({ tree: null, providerKilled: true })

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'codex-app-server-teardown' })
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('claims no Windows provider kill when TerminateProcess was not delivered', async () => {
    const target = { pid: 1234, kill: vi.fn<ChildProcess['kill']>(() => false) }
    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'win32',
        terminateWindowsTree: async () => undefined
      })
    ).resolves.toEqual({ tree: null, providerKilled: false })
  })

  it('passes a non-Codex diagnostic label to Windows teardown', async () => {
    const terminateWindowsTree = vi.fn(async () => undefined)

    await terminateProviderProcessTree(child(), {
      site: 'provider-test-teardown',
      platform: 'win32',
      terminateWindowsTree
    })

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'provider-test-teardown' })
  })

  it("kills the provider's group, then the supervisor, before judging the rest of the tree", async () => {
    const target = child()
    const order: string[] = []
    target.kill.mockImplementation((signal) => {
      order.push(`supervisor ${String(signal)}`)
      return true
    })
    const walk = supervisorWalk()
    const release = Promise.withResolvers<DescendantTreeVerdict>()
    const terminateDescendants = vi.fn((snapshot: DescendantSnapshot) => {
      order.push(`verify ${snapshot.descendants.length}`)
      return release.promise
    })

    const teardown = terminateProviderProcessTree(target, {
      site: 'codex-app-server-teardown',
      platform: 'darwin',
      captureDescendants: async () => walk,
      terminateDescendants,
      signalProcessGroup: (pgid, signal) => order.push(`group ${pgid} ${signal}`)
    })
    await vi.waitFor(() => expect(terminateDescendants).toHaveBeenCalledWith(walk))
    release.resolve('exited')
    await expect(teardown).resolves.toEqual({ tree: 'exited', providerKilled: true })

    expect(order).toEqual([
      'supervisor SIGSTOP',
      'group 1235 SIGKILL',
      'supervisor SIGKILL',
      'verify 1'
    ])
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
      expect.objectContaining({
        pid: 1235,
        site: 'codex-app-server-teardown',
        scope: 'posix-process-group'
      })
    ])
  })

  it.each(['live', 'unverifiable'] as const)(
    'reports a %s descendant left outside the killed group as-is, and still counts the provider killed',
    async (observed) => {
      const target = child()
      await expect(
        terminateProviderProcessTree(target, {
          site: 'codex-app-server-teardown',
          platform: 'darwin',
          captureDescendants: async () => supervisorWalk(),
          terminateDescendants: async () => observed,
          signalProcessGroup: () => {}
        })
      ).resolves.toEqual({ tree: observed, providerKilled: true })
      expect(signals(target)).toEqual(['SIGSTOP', 'SIGKILL'])
    }
  )

  // Before: an unreadable table SIGKILLed the paused supervisor, orphaning the provider in its own
  // group with nobody left to stop it, and the root's exit then read as the provider gone.
  it('never kills the supervisor without the group kill when the process table cannot be read', async () => {
    const target = child()
    const signalProcessGroup = vi.fn()
    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'darwin',
        captureDescendants: async () => null,
        signalProcessGroup
      })
    ).resolves.toEqual({ tree: null, providerKilled: false })
    expect(signals(target)).toEqual(['SIGSTOP', 'SIGCONT'])
    expect(signalProcessGroup).not.toHaveBeenCalled()
  })

  /**
   * `selfInitiatedTreeKillCount` decides whether a `render-process-gone` was
   * ours. A group that had already exited was killed by nobody, so crediting it
   * puts a suspect in the five-second window that Orca never issued. Exercised
   * through the real `process.kill(-pgid)` because the swallow being tested
   * lives in the production default, not in an injectable seam.
   */
  it('does not claim a provider group that was already gone, yet knows nothing in it runs', async () => {
    const target = child()

    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'darwin',
        captureDescendants: async () => supervisorWalk(UNREACHABLE_PGID),
        terminateDescendants: async () => 'exited'
      })
    ).resolves.toEqual({ tree: 'exited', providerKilled: true })

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])
  })

  it('signals a proven dedicated POSIX process group without scanning descendants', async () => {
    const target = child()
    const captureDescendants = vi.fn()
    const signalProcessGroup = vi.fn()

    await expect(
      terminateProviderProcessTree(target, {
        site: 'provider-test-teardown',
        platform: 'darwin',
        dedicatedProcessGroup: true,
        captureDescendants,
        signalProcessGroup
      })
    ).resolves.toEqual({ tree: null, providerKilled: true })

    expect(signalProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL')
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(target.kill).not.toHaveBeenCalled()
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
      expect.objectContaining({ site: 'provider-test-teardown', scope: 'posix-process-group' })
    ])
  })

  it('keeps the dedicated-group wrapper reachable when signalling is unproven', async () => {
    const target = child()

    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'linux',
        dedicatedProcessGroup: true,
        signalProcessGroup: () => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' })
        }
      })
    ).resolves.toEqual({ tree: 'unverifiable', providerKilled: false })

    expect(target.kill).not.toHaveBeenCalled()
  })

  it('claims no observation from an ESRCH dedicated group and reports a spawnless child as unverifiable', async () => {
    await expect(
      terminateProviderProcessTree(child(), {
        site: 'provider-test-teardown',
        platform: 'linux',
        dedicatedProcessGroup: true,
        signalProcessGroup: () => {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
      })
    ).resolves.toEqual({ tree: null, providerKilled: false })
    const spawnless = { pid: undefined, kill: vi.fn<ChildProcess['kill']>(() => true) }
    await expect(
      terminateProviderProcessTree(spawnless, { site: 'provider-test-teardown', platform: 'linux' })
    ).resolves.toEqual({ tree: 'unverifiable', providerKilled: false })
  })

  it('tears down 40 dedicated groups without process-table scans or cross-group fanout', async () => {
    const killMocks = Array.from({ length: 40 }, () => vi.fn<ChildProcess['kill']>(() => true))
    const targets = killMocks.map((kill, index) => ({
      pid: 10_000 + index,
      kill
    }))
    const captureDescendants = vi.fn()
    const signalProcessGroup = vi.fn()

    const results = await Promise.all(
      targets.map((target) =>
        terminateProviderProcessTree(target, {
          site: 'codex-app-server-teardown',
          platform: 'linux',
          dedicatedProcessGroup: true,
          captureDescendants,
          signalProcessGroup
        })
      )
    )

    expect(results).toEqual(
      Array.from({ length: targets.length }, () => ({ tree: null, providerKilled: true }))
    )
    expect(signalProcessGroup.mock.calls).toEqual(targets.map((target) => [target.pid, 'SIGKILL']))
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(killMocks.every((kill) => kill.mock.calls.length === 0)).toBe(true)
  })
})
