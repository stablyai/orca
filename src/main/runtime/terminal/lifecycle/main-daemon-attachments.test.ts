import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainDaemonAttachments } from './main-daemon-attachments'

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MainDaemonAttachments.reattachPendingSince', () => {
  it('starts when a re-attach becomes pending, survives a retry after a further loss, and resets once attached', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const finishers: ((attached: boolean) => void)[] = []
    const tracker = new MainDaemonAttachments({
      isAttachableLocalSession: () => true,
      hasMainTerminalState: () => true,
      attachProvider: () => new Promise<boolean>((resolve) => finishers.push(resolve))
    })

    tracker.noteEndpointLoss('pty-1')
    expect(tracker.reattachPendingSince('pty-1')).toBe(1000)
    await settle()

    now = 4000
    tracker.noteEndpointLoss('pty-1')
    finishers.shift()?.(true)
    await settle()
    expect(tracker.pendingReattach('pty-1')).toBeDefined()
    expect(tracker.reattachPendingSince('pty-1')).toBe(1000)

    finishers.shift()?.(true)
    await settle()
    expect(tracker.pendingReattach('pty-1')).toBeUndefined()
    expect(tracker.reattachPendingSince('pty-1')).toBeUndefined()

    now = 30_000
    tracker.noteEndpointLoss('pty-1')
    expect(tracker.reattachPendingSince('pty-1')).toBe(30_000)
  })
})
