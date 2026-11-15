import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSelfInitiatedTreeKillLogForTest } from '../crash-reporting/process-exits/self-initiated-tree-kill-log'
import type { DescendantTreeVerdict } from '../pty/process-retirement/pty-descendant-exit-verification'
import { terminateProviderProcessTree as terminateWithEvidence } from './provider-process-teardown'

async function terminateProviderProcessTree(...args: Parameters<typeof terminateWithEvidence>) {
  const verdict = await terminateWithEvidence(...args)
  return typeof verdict === 'object' && verdict ? verdict.tree : verdict
}

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

  // An intercepted ESRCH must exercise the default signal path without creating a false kill breadcrumb.

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
})

it('records a held provider kill without claiming unobserved descendants exited', async () => {
  const target = { ...child(), leaderExited: false, writerPid: 1234 }
  await expect(
    terminateWithEvidence(target, {
      site: 'writer-kill-proof',
      platform: 'linux',
      supervised: true,
      captureDescendants: async () => null
    })
  ).resolves.toEqual({ tree: null, killDelivered: true })

  target.kill.mockReturnValue(false)
  await expect(
    terminateWithEvidence(target, {
      site: 'writer-kill-proof',
      platform: 'linux',
      supervised: true,
      captureDescendants: async () => null
    })
  ).resolves.toBeNull()
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

it('never reads or signals a retired group PID when the CLI wait outcome is unknown', async () => {
  const target = { ...child(), leaderExited: false, groupVerdict: 'exited' as const }
  const captureDescendants = vi.fn()
  await expect(
    terminateWithEvidence(target, {
      site: 'lost-parent-test',
      platform: 'darwin',
      supervised: true,
      captureDescendants
    })
  ).resolves.toBeNull()
  expect(target.kill).not.toHaveBeenCalled()
  expect(captureDescendants).not.toHaveBeenCalled()
})

it('discards an in-flight tree read after native group absence retires its PID', async () => {
  const target = { ...child(), leaderExited: false, groupVerdict: 'live' as DescendantTreeVerdict }
  const snapshot = Promise.withResolvers<{
    rootPgid: number
    descendants: never[]
    capturedAtMs: number
  }>()
  const terminateDescendants = vi.fn()
  const signalProcessGroup = vi.fn()
  const teardown = terminateWithEvidence(target, {
    site: 'lost-parent-test',
    platform: 'darwin',
    supervised: true,
    captureDescendants: () => snapshot.promise,
    terminateDescendants,
    signalProcessGroup
  })
  target.groupVerdict = 'exited'
  snapshot.resolve({ rootPgid: 1234, descendants: [], capturedAtMs: 1 })
  await expect(teardown).resolves.toBeNull()
  expect(target.kill.mock.calls).toEqual([['SIGSTOP']])
  expect(terminateDescendants).not.toHaveBeenCalled()
  expect(signalProcessGroup).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)(
  'discards snapshot signals after retirement during descendant %s',
  async (result) => {
    const target = {
      ...child(),
      leaderExited: false,
      groupVerdict: 'live' as DescendantTreeVerdict
    }
    const release = Promise.withResolvers<DescendantTreeVerdict>()
    const started = Promise.withResolvers<void>()
    const signalProcess = vi.fn()
    const signalProcessGroup = vi.fn()
    const teardown = terminateWithEvidence(target, {
      site: 'retired-during-descendants',
      platform: 'darwin',
      supervised: true,
      captureDescendants: async () => ({
        rootPgid: 1234,
        capturedAtMs: 1,
        descendants: [{ pid: 2000, ppid: 1234, pgid: 2000, startedAt: 'then' }]
      }),
      terminateDescendants: () => {
        started.resolve()
        return release.promise
      },
      signalProcess,
      signalProcessGroup
    })
    await started.promise
    target.groupVerdict = 'exited'
    if (result === 'resolve') {
      release.resolve('exited')
    } else {
      release.reject(new Error('read failed'))
    }
    await teardown
    expect(target.kill.mock.calls).toEqual([['SIGSTOP']])
    expect(signalProcess).not.toHaveBeenCalled()
    expect(signalProcessGroup).not.toHaveBeenCalled()
  }
)

it('does not read or signal snapshot identities when root pinning fails', async () => {
  const target = child()
  target.kill.mockReturnValue(false)
  const captureDescendants = vi.fn()
  await expect(
    terminateWithEvidence(target, {
      site: 'failed-pin',
      platform: 'darwin',
      supervised: true,
      captureDescendants
    })
  ).resolves.toBeNull()
  expect(captureDescendants).not.toHaveBeenCalled()
  expect(target.kill.mock.calls).toEqual([['SIGSTOP'], ['SIGKILL']])
})
