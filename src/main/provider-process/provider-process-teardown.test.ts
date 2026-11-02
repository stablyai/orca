import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { terminateProviderProcessTree as terminateWithEvidence } from './provider-process-teardown'

async function terminateProviderProcessTree(...args: Parameters<typeof terminateWithEvidence>) {
  const verdict = await terminateWithEvidence(...args)
  return typeof verdict === 'object' && verdict ? verdict.tree : verdict
}

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

  it('waits for the Windows tree kill before releasing the wrapper, and reports what taskkill reported', async () => {
    const target = child()
    const release = Promise.withResolvers<boolean>()
    const terminateWindowsTree = vi.fn(() => release.promise)

    const teardown = terminateWithEvidence(target, {
      site: 'codex-app-server-teardown',
      platform: 'win32',
      terminateWindowsTree
    })
    expect(target.kill).not.toHaveBeenCalled()
    release.resolve(true)
    await expect(teardown).resolves.toEqual({ tree: 'exited', killDelivered: true })

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'codex-app-server-teardown' })
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports an unproven Windows tree when taskkill does not exit cleanly', async () => {
    const target = child()

    await expect(
      terminateWithEvidence(target, {
        site: 'codex-app-server-teardown',
        platform: 'win32',
        terminateWindowsTree: async () => false
      })
    ).resolves.toBe('unverifiable')
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('passes a non-Codex diagnostic label to Windows teardown', async () => {
    const terminateWindowsTree = vi.fn(async () => true)

    await terminateProviderProcessTree(child(), {
      site: 'provider-test-teardown',
      platform: 'win32',
      terminateWindowsTree
    })

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'provider-test-teardown' })
  })

  it('waits for an owned POSIX snapshot before killing the wrapper', async () => {
    const target = child()
    const signalProcessGroup = vi.fn()
    const snapshot = { rootPgid: 1234, descendants: [], capturedAtMs: 1 }
    const release = Promise.withResolvers<DescendantTreeVerdict>()

    const teardown = terminateProviderProcessTree(target, {
      site: 'codex-app-server-teardown',
      platform: 'darwin',
      captureDescendants: async () => snapshot,
      terminateDescendants: () => release.promise,
      signalProcessGroup
    })
    await vi.waitFor(() => expect(target.kill).toHaveBeenCalledWith('SIGSTOP'))
    expect(target.kill).not.toHaveBeenCalledWith('SIGKILL')
    release.resolve('exited')
    await expect(teardown).resolves.toBe('exited')

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(signalProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL')
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

  // An intercepted ESRCH must exercise the default signal path without creating a false kill breadcrumb.
  it('does not claim a snapshot group that was already gone', async () => {
    const target = { pid: UNREACHABLE_PGID, kill: vi.fn<ChildProcess['kill']>(() => true) }
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })
    try {
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

      expect(kill).toHaveBeenCalledWith(-UNREACHABLE_PGID, 'SIGKILL')
      expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
      expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])
    } finally {
      kill.mockRestore()
    }
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
    'reports a %s descendant snapshot after killing anchored child groups and the held root',
    async (observed, verdict) => {
      const target = child()
      const signalProcessGroup = vi.fn()
      const signalProcess = vi.fn()
      await expect(
        terminateProviderProcessTree(target, {
          site: 'codex-app-server-teardown',
          platform: 'darwin',
          captureDescendants: async () => ({
            rootPgid: 1234,
            descendants: [
              { pid: 2000, ppid: 1234, pgid: 2000, startedAt: 'now' },
              { pid: 3000, ppid: 2000, pgid: 2000, startedAt: 'now' }
            ],
            capturedAtMs: 1
          }),
          terminateDescendants: async () => observed,
          signalProcessGroup,
          signalProcess
        })
      ).resolves.toBe(verdict)
      expect(signalProcessGroup).toHaveBeenCalledWith(2000, 'SIGKILL')
      expect(signalProcess).toHaveBeenCalledWith(2000, 'SIGKILL')
      expect(signalProcess).not.toHaveBeenCalledWith(3000, 'SIGKILL')
      expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
      expect(signalProcess.mock.invocationCallOrder[0]).toBeLessThan(
        target.kill.mock.invocationCallOrder.at(-1)!
      )
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

it('counts the writer group kill, but never a supervisor-only kill, without an exit report', async () => {
  const target = child()
  const snapshot = {
    rootPgid: 1234,
    capturedAtMs: 1,
    descendants: [{ pid: 5678, ppid: 1234, pgid: 5678, startedAt: 'now' }]
  }
  const deps = {
    site: 'writer-kill-proof',
    platform: 'linux' as const,
    supervised: true,
    captureDescendants: async () => snapshot,
    terminateDescendants: async () => 'unverifiable' as const,
    signalProcessGroup: vi.fn(),
    signalProcess: vi.fn()
  }
  await expect(terminateWithEvidence(target, deps)).resolves.toEqual({
    tree: 'unverifiable',
    killDelivered: true
  })
  await expect(
    terminateWithEvidence(child(), { ...deps, captureDescendants: async () => null })
  ).resolves.toBeNull()
  await expect(
    terminateWithEvidence(child(), {
      ...deps,
      signalProcessGroup: () => {
        throw new Error('denied')
      }
    })
  ).resolves.toBe('unverifiable')
})

it.each([true, false])(
  'preserves taskkill=%s when exact-root cleanup throws',
  async (delivered) => {
    const target = child()
    target.kill.mockImplementation(() => {
      throw new Error('held root cleanup failed')
    })
    await expect(
      terminateWithEvidence(target, {
        site: 'fixture-cleanup',
        platform: 'win32',
        terminateWindowsTree: async () => delivered
      })
    ).resolves.toEqual(delivered ? { tree: 'exited', killDelivered: true } : 'unverifiable')
  }
)
