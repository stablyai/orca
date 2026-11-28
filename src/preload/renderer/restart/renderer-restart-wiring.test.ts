import { describe, expect, it, vi } from 'vitest'
import { ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT } from '../../../shared/updater/updater-renderer-events'
import { prepareAndInvokeUpdaterInstall } from './renderer-restart-wiring'

describe('prepareAndInvokeUpdaterInstall', () => {
  // Preparation dispatches restart events synchronously; a listener that asks to install again
  // must join the request in flight, or the app would prepare and install twice.
  it('runs one install when a restart listener re-enters synchronously', async () => {
    const window = new EventTarget()
    const relay = { markPrepared: vi.fn(), abort: vi.fn() }
    const invoke = vi.fn(async () => {})
    const install = (): Promise<void> =>
      prepareAndInvokeUpdaterInstall(window, relay, invoke, async () => {})

    let reentered: Promise<void> | undefined
    window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, () => {
      reentered ??= install()
    })

    const first = install()
    expect(reentered).toBe(first)
    await first

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(relay.markPrepared).toHaveBeenCalledTimes(1)
  })
})
