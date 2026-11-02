import { describe, expect, it, vi } from 'vitest'
import { recoverDaemonAfterCancelledIdleStop } from './orcad-idle-stop-daemon-recovery'

function ports(
  options: { admissionClosed?: boolean; retry?: 'retired' | 'live' | 'unverifiable' } = {}
) {
  let closed = options.admissionClosed ?? false
  return {
    admissionClosed: vi.fn(() => closed),
    retireAgain: vi.fn(async () => {
      const retirement = options.retry ?? 'unverifiable'
      // Only a refusal the daemon answered reopens admission.
      closed = retirement !== 'live'
      return { retirement }
    }),
    replaceDaemon: vi.fn(async () => {}),
    timeoutMs: 20
  }
}

describe('daemon recovery after a cancelled idle stop', () => {
  it('replaces a daemon that retired', async () => {
    const recovery = ports({ admissionClosed: true })
    expect(await recoverDaemonAfterCancelledIdleStop({ retirement: 'retired' }, recovery)).toBe(
      'serving'
    )
    expect(recovery.replaceDaemon).toHaveBeenCalledOnce()
    expect(recovery.retireAgain).not.toHaveBeenCalled()
  })

  it('replaces a daemon whose retirement landed after the stop timed out', async () => {
    const recovery = ports({ admissionClosed: true })
    const outcome = { retirement: 'unverifiable' as const, lateRetirement: Promise.resolve(true) }
    expect(await recoverDaemonAfterCancelledIdleStop(outcome, recovery)).toBe('serving')
    expect(recovery.replaceDaemon).toHaveBeenCalledOnce()
  })

  it('keeps a daemon whose late reply refused retirement and reopened admission', async () => {
    const recovery = ports()
    const outcome = { retirement: 'unverifiable' as const, lateRetirement: Promise.resolve(false) }
    expect(await recoverDaemonAfterCancelledIdleStop(outcome, recovery)).toBe('serving')
    expect(recovery.replaceDaemon).not.toHaveBeenCalled()
  })

  it('asks a daemon whose stop reply was lost again, and replaces it once it retires', async () => {
    const recovery = ports({ admissionClosed: true, retry: 'retired' })
    expect(
      await recoverDaemonAfterCancelledIdleStop({ retirement: 'unverifiable' }, recovery)
    ).toBe('serving')
    expect(recovery.retireAgain).toHaveBeenCalledOnce()
    expect(recovery.replaceDaemon).toHaveBeenCalledOnce()
  })

  it('keeps a fenced daemon that refuses the second ask', async () => {
    const recovery = ports({ admissionClosed: true, retry: 'live' })
    expect(
      await recoverDaemonAfterCancelledIdleStop({ retirement: 'unverifiable' }, recovery)
    ).toBe('serving')
    expect(recovery.replaceDaemon).not.toHaveBeenCalled()
  })

  it('never replaces a fenced daemon that stays unanswered', async () => {
    const recovery = ports({ admissionClosed: true, retry: 'unverifiable' })
    expect(
      await recoverDaemonAfterCancelledIdleStop({ retirement: 'unverifiable' }, recovery)
    ).toBe('unservable')
    expect(recovery.replaceDaemon).not.toHaveBeenCalled()
  })

  it('reports a failed replacement as unservable', async () => {
    const recovery = ports()
    recovery.replaceDaemon.mockRejectedValueOnce(new Error('spawn failed'))
    expect(await recoverDaemonAfterCancelledIdleStop({ retirement: 'retired' }, recovery)).toBe(
      'unservable'
    )
  })
})
