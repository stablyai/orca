import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'

describe('DaemonPtyRouter listing budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the daemon no more once the budget is spent, even when the last read went stale', async () => {
    vi.useFakeTimers()
    const current = createAdapter('current', ['shell-a'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    const list = vi.mocked(current.listProcesses)
    const readsBefore = list.mock.calls.length
    list.mockImplementationOnce(async () => {
      // The read outlasts the 2 s budget and a terminal exits while it runs.
      vi.setSystemTime(Date.now() + 3_000)
      current.emitExit('shell-a', 0)
      return [{ id: 'shell-a', cwd: '', title: '' }]
    })

    const settled = router.listProcesses().then(
      () => 'listed',
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(await settled).toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(list.mock.calls.length - readsBefore).toBe(1)
  })

  it('reads the daemon no more once the caller has left, even when the last read went stale', async () => {
    const current = createAdapter('current', ['shell-a'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    const list = vi.mocked(current.listProcesses)
    const readsBefore = list.mock.calls.length
    let wanted = true
    list.mockImplementationOnce(async () => {
      // The panel closes and a terminal exits while the read runs.
      wanted = false
      current.emitExit('shell-a', 0)
      return [{ id: 'shell-a', cwd: '', title: '' }]
    })

    await expect(router.listProcesses({ isWanted: () => wanted })).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(list.mock.calls.length - readsBefore).toBe(1)
  })

  it('does not repeat a failed read just because a terminal changed during it', async () => {
    const current = createAdapter('current', ['shell-a'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    const list = vi.mocked(current.listProcesses)
    const readsBefore = list.mock.calls.length
    list.mockImplementationOnce(async () => {
      current.emitExit('shell-a', 0)
      throw new Error('daemon list failed')
    })

    await expect(router.listProcesses()).rejects.toThrow('daemon list failed')
    expect(list.mock.calls.length - readsBefore).toBe(1)
  })
})
