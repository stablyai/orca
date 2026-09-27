import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, state } = vi.hoisted(() => {
  const state: {
    firstWindowStartupServicesReady: Promise<void>
    managedWslCliStartupBarrierReady: Promise<void>
    runtime: null | { prepareStructuredAgentSessionStartupRestoration: () => Promise<void> }
  } = {
    firstWindowStartupServicesReady: Promise.resolve(),
    managedWslCliStartupBarrierReady: Promise.resolve(),
    runtime: null
  }
  return { handlers: new Map<string, (...args: unknown[]) => unknown>(), state }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('./legacy-worker-renderer-recovery', () => ({
  recoverLegacyWorkerTerminalsForRendererStartup: vi.fn()
}))
vi.mock('./os-opened-markdown-files', () => ({ resolveOpenedMarkdownDocuments: vi.fn() }))

import { registerMainProcessIpcHandlers } from './main-process-ipc-bootstrap'

describe('app:prepareTerminalStartupRestoration', () => {
  beforeEach(() => {
    handlers.clear()
    registerMainProcessIpcHandlers()
  })

  it('answers the renderer once the barriers settle while chat restoration still hangs', async () => {
    const prepare = vi.fn(() => new Promise<void>(() => {}))
    state.runtime = { prepareStructuredAgentSessionStartupRestoration: prepare }

    await expect(
      Promise.resolve(handlers.get('app:prepareTerminalStartupRestoration')?.())
    ).resolves.toBeUndefined()
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('reports a chat restoration failure without failing the renderer step', async () => {
    const failure = new Error('host install failed')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.runtime = {
      prepareStructuredAgentSessionStartupRestoration: () => Promise.reject(failure)
    }

    await expect(handlers.get('app:prepareTerminalStartupRestoration')?.()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.any(String), failure))
    logged.mockRestore()
  })
})
