import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('@orca/process-host/fork-process', () => ({ forkProcess: fork }))

async function exerciseRetirement(kill: () => boolean): Promise<void> {
  vi.useFakeTimers()
  vi.resetModules()
  const stuck = Object.assign(new EventEmitter(), {
    connected: true,
    unref() {},
    send() {},
    kill
  })
  const replacement = Object.assign(new EventEmitter(), {
    connected: true,
    unref() {},
    kill: () => true,
    send(request: { id: number }) {
      Promise.resolve().then(() =>
        replacement.emit('message', { id: request.id, fingerprint: 'recovered' })
      )
    }
  })
  fork.mockReset().mockReturnValueOnce(stuck).mockReturnValue(replacement)
  try {
    const { readRepoWorktreeAdminFingerprint } = await import('./repo-worktree-admin-fingerprint')
    const { GIT_ADMIN_PROBE_UNAVAILABLE } =
      await import('../../../../shared/git/metadata/git-admin-probe-result')
    const first = readRepoWorktreeAdminFingerprint('blocked-repository')
    await vi.advanceTimersByTimeAsync(3_500)
    expect(await first).toBe(GIT_ADMIN_PROBE_UNAVAILABLE)

    await vi.advanceTimersByTimeAsync(30_001)
    expect(await readRepoWorktreeAdminFingerprint('retry-before-exit')).toBe(
      GIT_ADMIN_PROBE_UNAVAILABLE
    )

    stuck.emit('exit', null)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await readRepoWorktreeAdminFingerprint('retry-after-exit')).toBe('recovered')
  } finally {
    stuck.emit('close', null)
    replacement.emit('close', 0)
    vi.useRealTimers()
  }
}

it('waits for physical exit after a successful termination signal', async () => {
  await exerciseRetirement(() => true)
})

it('waits for physical exit even when termination signalling fails', async () => {
  await exerciseRetirement(() => {
    throw new Error('signal denied')
  })
})
