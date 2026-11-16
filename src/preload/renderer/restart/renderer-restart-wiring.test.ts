import { describe, expect, it, vi } from 'vitest'

import { ORCA_APP_RESTART_ABORTED_EVENT } from '../../../shared/updater/updater-renderer-events'
import { prepareAndInvokeAppRestart } from './renderer-restart-wiring'

describe('renderer restart wiring', () => {
  it('refuses overlapping preparation without abandoning the accepted restart', async () => {
    const eventTarget = new EventTarget()
    const aborted = vi.fn()
    eventTarget.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
    const checkpoint = Promise.withResolvers<void>()
    const invoke = vi.fn(async () => true)
    const first = prepareAndInvokeAppRestart(eventTarget, invoke, () => checkpoint.promise)
    const refused = vi.fn(async () => false)
    await expect(
      prepareAndInvokeAppRestart(eventTarget, refused, async () => {}, Boolean)
    ).rejects.toThrow('already in progress')
    expect(refused).not.toHaveBeenCalled()
    expect(aborted).not.toHaveBeenCalled()
    checkpoint.resolve()
    await expect(first).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
  })
})
