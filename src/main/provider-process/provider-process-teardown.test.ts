import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import type { DescendantTreeVerdict } from '../pty/process-retirement/pty-descendant-exit-verification'
import { collectDescendantRows } from '../pty/process-retirement/pty-descendant-termination'
import { terminateProviderProcessTree as terminateWithEvidence } from './provider-process-teardown'

function child() {
  return { pid: 1234, kill: vi.fn<ChildProcess['kill']>(() => true) }
}

function supervisedChild(groupVerdict: DescendantTreeVerdict) {
  return { ...child(), leaderExited: false, groupVerdict }
}

it('stops surviving group members while an exited unreaped root still reserves its group', async () => {
  let groupRunning = true
  await terminateWithEvidence(child(), {
    site: 'unreaped-root',
    platform: 'darwin',
    captureDescendants: async () =>
      collectDescendantRows(1234, [
        { pid: 1234, ppid: 1, pgid: 1234, startedAt: 'Mon Jul 13 12:54:47 2026', zombie: true },
        { pid: 2000, ppid: 1, pgid: 1234, startedAt: 'Mon Jul 13 12:54:47 2026' }
      ]),
    signalProcessGroup: (pgid, signal) => {
      if (pgid === 1234 && signal === 'SIGKILL') {
        groupRunning = false
      }
    }
  })
  expect(groupRunning).toBe(false)
})

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
  const target = supervisedChild('live')
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
    const target = supervisedChild('live')
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
