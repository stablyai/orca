import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPtyHostBindings, type PtyIpcSurface } from '../pty-host-bindings'
import type * as Registry from '../provider/registry'
import { installPtyInspectIpcHandlers } from './inspect'

const mocks = vi.hoisted(() => {
  const provider: { supportsForegroundObservation?: (id: string) => boolean } = {}
  return { provider, inspect: vi.fn() }
})

vi.mock('../provider/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof Registry>()),
  hasPtyProviderForInspection: () => true,
  getProviderForPty: () => mocks.provider
}))

vi.mock('../../../providers/pty/process-inspection', () => ({
  inspectPtyProviderProcessForRenderer: mocks.inspect
}))

const handlers = new Map<string, Parameters<PtyIpcSurface['handle']>[1]>()
// The handler ignores its event, and a real IpcMainInvokeEvent needs a live WebContents.
const ipcEvent: IpcMainInvokeEvent = Object.create(null)

function inspectProcess(args: unknown): unknown {
  return handlers.get('pty:inspectProcess')?.(ipcEvent, args)
}

beforeEach(() => {
  setPtyHostBindings({
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener),
      on: () => {},
      removeHandler: () => {},
      removeAllListeners: () => {}
    }
  })
  installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: () => undefined })
  mocks.inspect.mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false })
})

afterEach(() => {
  setPtyHostBindings({})
  handlers.clear()
  mocks.inspect.mockReset()
  delete mocks.provider.supportsForegroundObservation
})

describe('pty:inspectProcess foregroundOnly', () => {
  it.each([
    ['has no fenced foreground read', undefined],
    ['declines a fenced read for this pane', () => false]
  ])('answers old_host without inspecting when the provider %s', async (_, supports) => {
    if (supports) {
      mocks.provider.supportsForegroundObservation = supports
    }

    await expect(inspectProcess({ id: 'pty-1', foregroundOnly: true })).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'old_host'
    })
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it('forwards foregroundOnly to a provider with fenced foreground reads', async () => {
    mocks.provider.supportsForegroundObservation = () => true

    await inspectProcess({ id: 'pty-1', foregroundOnly: true })

    expect(mocks.inspect).toHaveBeenCalledWith(mocks.provider, 'pty-1', { foregroundOnly: true })
  })
})
