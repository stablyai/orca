import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { terminateProviderProcessTree } from './provider-process-teardown'

/** Above pid_max on every supported POSIX host, so the group signal is a real ESRCH. */
const UNREACHABLE_PGID = 2_147_483_647

function child() {
  return {
    pid: 1234,
    kill: vi.fn<ChildProcess['kill']>(() => true)
  }
}

describe('terminateProviderProcessTree', () => {
  beforeEach(() => {
    resetSelfInitiatedTreeKillLogForTest()
  })

  it('waits for the Windows tree kill before releasing the wrapper, and claims no observation', async () => {
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
    // taskkill resolves alike on success, failure and timeout.
    await expect(teardown).resolves.toBeNull()

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'codex-app-server-teardown' })
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
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

  it('waits for an owned POSIX snapshot before killing the wrapper', async () => {
    const target = child()
    const snapshot = { rootPgid: 1234, descendants: [], capturedAtMs: 1 }
    const release = Promise.withResolvers<DescendantTreeVerdict>()

    const teardown = terminateProviderProcessTree(target, {
      site: 'codex-app-server-teardown',
      platform: 'darwin',
      captureDescendants: async () => snapshot,
      terminateDescendants: () => release.promise
    })
    await vi.waitFor(() => expect(target.kill).toHaveBeenCalledWith('SIGSTOP'))
    expect(target.kill).not.toHaveBeenCalledWith('SIGKILL')
    release.resolve('exited')
    await expect(teardown).resolves.toBe('exited')

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
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
    ).resolves.toBeNull()

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
    ).resolves.toBe('unverifiable')

    expect(target.kill).not.toHaveBeenCalled()
  })

  /**
   * `selfInitiatedTreeKillCount` decides whether a `render-process-gone` was
   * ours. A group that had already exited was killed by nobody, so crediting it
   * puts a suspect in the five-second window that Orca never issued. Exercised
   * through the real `process.kill(-pgid)` because the swallow being tested
   * lives in the production default, not in an injectable seam.
   */
  it('does not claim a snapshot group that was already gone', async () => {
    const target = { pid: UNREACHABLE_PGID, kill: vi.fn<ChildProcess['kill']>(() => true) }

    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'darwin',
        captureDescendants: async () => ({
          rootPgid: UNREACHABLE_PGID,
          descendants: [],
          capturedAtMs: 1
        }),
        terminateDescendants: async () => 'exited'
      })
    ).resolves.toBe('exited')

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])
  })

  it('claims a snapshot group the signal actually reached', async () => {
    const target = child()
    const signalProcessGroup = vi.fn()

    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'darwin',
        captureDescendants: async () => ({ rootPgid: 1234, descendants: [], capturedAtMs: 1 }),
        terminateDescendants: async () => 'exited',
        signalProcessGroup
      })
    ).resolves.toBe('exited')

    expect(signalProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL')
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
      expect.objectContaining({
        pid: 1234,
        site: 'codex-app-server-teardown',
        scope: 'posix-process-group'
      })
    ])
  })

  it.each([
    ['live', 'live'],
    ['unverifiable', 'unverifiable']
  ] as const)(
    'reports a %s descendant snapshot as-is and leaves the stopped root resumable',
    async (observed, verdict) => {
      const target = child()
      await expect(
        terminateProviderProcessTree(target, {
          site: 'codex-app-server-teardown',
          platform: 'darwin',
          captureDescendants: async () => ({ rootPgid: 1234, descendants: [], capturedAtMs: 1 }),
          terminateDescendants: async () => observed
        })
      ).resolves.toBe(verdict)
      expect(target.kill).toHaveBeenLastCalledWith('SIGCONT')
    }
  )

  it('claims no observation when the POSIX process table cannot be read', async () => {
    const target = child()
    await expect(
      terminateProviderProcessTree(target, {
        site: 'codex-app-server-teardown',
        platform: 'darwin',
        captureDescendants: async () => null
      })
    ).resolves.toBeNull()
    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
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
    ).resolves.toBeNull()
    const spawnless = { pid: undefined, kill: vi.fn<ChildProcess['kill']>(() => true) }
    await expect(
      terminateProviderProcessTree(spawnless, { site: 'provider-test-teardown', platform: 'linux' })
    ).resolves.toBe('unverifiable')
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

    expect(results).toEqual(Array.from({ length: targets.length }, () => null))
    expect(signalProcessGroup.mock.calls).toEqual(targets.map((target) => [target.pid, 'SIGKILL']))
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(killMocks.every((kill) => kill.mock.calls.length === 0)).toBe(true)
  })
})
