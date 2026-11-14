import { describe, expect, it, vi } from 'vitest'

import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'
import {
  prepareAndInvokeAppRestart,
  prepareAndInvokeUpdaterInstall
} from './renderer-restart-wiring'

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

  it('marks preparation before invoking main and aborts on IPC failure', async () => {
    const eventTarget = new EventTarget()
    const calls: string[] = []
    eventTarget.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, () => {
      calls.push('prepared')
    })
    const relay = {
      markPrepared: () => calls.push('marked'),
      abort: () => calls.push('aborted')
    }
    const invoke = vi.fn(async () => {
      calls.push('invoked')
      throw new Error('IPC failed')
    })

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, async () => {
        calls.push('checkpoint-flushed')
      })
    ).rejects.toThrow('IPC failed')

    expect(calls).toEqual(['prepared', 'checkpoint-flushed', 'marked', 'invoked', 'aborted'])
  })

  it('never installs the update when the shutdown checkpoint fails to persist', async () => {
    const eventTarget = new EventTarget()
    const invoke = vi.fn(() => Promise.resolve())
    const relay = { markPrepared: vi.fn(), abort: vi.fn() }

    await expect(
      prepareAndInvokeUpdaterInstall(eventTarget, relay, invoke, () =>
        Promise.reject(new Error('Failed to persist renderer state before unload.'))
      )
    ).rejects.toThrow('Failed to persist renderer state before unload.')

    expect(invoke).not.toHaveBeenCalled()
    expect(relay.markPrepared).not.toHaveBeenCalled()
  })
})
