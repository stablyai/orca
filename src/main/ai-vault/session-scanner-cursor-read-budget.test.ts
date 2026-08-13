import { describe, expect, it, vi } from 'vitest'
import { CURSOR_REMOTE_MAX_AGGREGATE_BYTES } from '../../shared/cursor-sidecar-scan'
import {
  createCursorVerifiedReadBudget,
  reserveCursorVerifiedReadBytes,
  settleCursorVerifiedReadReservation
} from './session-scanner-cursor-read-budget'

describe('Cursor verified-read reservation waits', () => {
  it('wakes when cancellation lands while waiting for reserved bytes', async () => {
    const budget = createCursorVerifiedReadBudget()
    budget.reservedBytes = CURSOR_REMOTE_MAX_AGGREGATE_BYTES
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const reservation = reserveCursorVerifiedReadBytes(budget, 1, controller.signal).then(
      () => 'reserved' as const,
      (error: unknown) => error
    )

    controller.abort()

    const outcome = await Promise.race([
      reservation,
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending')))
    ])
    expect(outcome).toMatchObject({ name: 'AbortError' })
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('removes its abort listener when reserved bytes become available', async () => {
    const budget = createCursorVerifiedReadBudget()
    budget.reservedBytes = CURSOR_REMOTE_MAX_AGGREGATE_BYTES
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const reservation = reserveCursorVerifiedReadBytes(budget, 1, controller.signal)

    settleCursorVerifiedReadReservation(budget, CURSOR_REMOTE_MAX_AGGREGATE_BYTES, 0)

    await expect(reservation).resolves.toBeGreaterThan(0)
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
