import { describe, expect, it, vi } from 'vitest'

import { createPluginWorkerRuntime } from './plugin-host-runtime'

const init = (overrides: { pluginRoot?: string; mainEntry?: string } = {}) => ({
  orca: 1,
  kind: 'evt',
  event: 'init',
  payload: {
    pluginId: 'samples.demo',
    pluginRoot: '/plugin',
    mainEntry: 'worker.js',
    grantedCapabilities: [],
    ...overrides
  }
})

describe('plugin worker shutdown', () => {
  it('awaits an optional deactivate export before exiting', async () => {
    let finishDeactivate!: () => void
    const deactivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeactivate = resolve
        })
    )
    const send = vi.fn()
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({ default: vi.fn(), deactivate })
    })
    await runtime.handleMessage(init())

    const shutdown = runtime.handleMessage({ orca: 1, kind: 'evt', event: 'shutdown' })
    await Promise.resolve()
    expect(deactivate).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    finishDeactivate()
    await shutdown

    expect(exit).toHaveBeenCalledWith(0)
  })
})
