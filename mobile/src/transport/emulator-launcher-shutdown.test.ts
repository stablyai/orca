import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { waitForEmulatorLauncherShutdown } from '../../scripts/emulator-launcher-shutdown.mjs'

describe('emulator launcher shutdown', () => {
  it('waits for disposable daemon cleanup before completing', async () => {
    const metroProcess = new EventEmitter()
    metroProcess.kill = vi.fn()
    const signalTarget = new EventEmitter()
    const closeOutput = vi.fn()
    const removeRuntimeRestart = vi.fn()
    let completeCleanup = () => {}
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeCleanup = resolve
        })
    )
    let settled = false
    const shutdown = waitForEmulatorLauncherShutdown(
      {
        metro: {
          process: metroProcess,
          isExited: () => false,
          closeOutput
        },
        removeRuntimeRestart,
        runtimeState: { current: { stop } }
      },
      signalTarget
    ).then(() => {
      settled = true
    })

    metroProcess.emit('exit')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(stop).toHaveBeenCalledWith({ shutdownDaemon: true })
    expect(settled).toBe(false)
    completeCleanup()
    await shutdown
    expect(closeOutput).toHaveBeenCalledOnce()
    expect(removeRuntimeRestart).toHaveBeenCalledOnce()
  })
})
