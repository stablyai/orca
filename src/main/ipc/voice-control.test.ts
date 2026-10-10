import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: { id: number } }, ...args: any[]) => unknown
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', async () => {
  // The transcript log lands under userData; point it at the OS temp dir.
  const { tmpdir } = await import('node:os')
  return {
    app: { getPath: () => tmpdir() },
    ipcMain: {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
      // describe_screen's snapshot response listener; these tests never drive it.
      on: vi.fn()
    },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    powerMonitor: { on: vi.fn() },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: vi.fn()
    }
  }
})
vi.mock('../network/http-client', () => ({ getMainHttpClient: () => ({ fetch: vi.fn() }) }))
vi.mock('../speech/openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: () => true,
  readOpenAiSpeechApiKey: () => 'sk-test'
}))
vi.mock('../voice-control/voice-control-backend-wiring', () => ({
  createVoiceControlBackendFactory: () => vi.fn()
}))

const serviceState: { state: string; sessionId: string | null } = {
  state: 'idle',
  sessionId: null
}
const serviceStartMock = vi.fn()
const serviceStopMock = vi.fn(async () => {
  serviceState.state = 'idle'
  serviceState.sessionId = null
})

vi.mock('../voice-control/voice-control-service', () => ({
  VoiceControlService: class {
    getState() {
      return { ...serviceState }
    }
    start = serviceStartMock
    stop = serviceStopMock
    exchangeSdp = vi.fn()
  }
}))

import { registerVoiceControlHandlers } from './voice-control'

function register(): void {
  handlers.clear()
  serviceState.state = 'idle'
  serviceState.sessionId = null
  serviceStartMock.mockReset()
  serviceStopMock.mockClear()
  const store = { getSettings: () => ({ voice: {} }) }
  const runtime = { getWorktreePs: async () => ({ worktrees: [] }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only getSettings().voice.control and getWorktreePs(); the full Store/Runtime surface is fixture weight.
  registerVoiceControlHandlers(store as never, runtime as never)
}

describe('voice-control:stop ownership', () => {
  beforeEach(register)

  it('refuses stop from a non-owner while a session is live', async () => {
    serviceStartMock.mockImplementation(async (sessionId: string) => {
      serviceState.state = 'live'
      serviceState.sessionId = sessionId
      return null
    })
    const start = handlers.get('voice-control:start')
    const stop = handlers.get('voice-control:stop')
    const ownerStart = await start?.({ sender: { id: 7 } })
    expect(ownerStart).toMatchObject({ ok: true })

    await stop?.({ sender: { id: 999 } }, serviceState.sessionId)
    expect(serviceStopMock).not.toHaveBeenCalled()
  })

  it('allows stop after a failed start parked the service in error with no owner', async () => {
    serviceStartMock.mockImplementation(async (sessionId: string) => {
      serviceState.state = 'error'
      serviceState.sessionId = sessionId
      return { kind: 'unknown', error: 'mint blew up' }
    })
    const start = handlers.get('voice-control:start')
    const stop = handlers.get('voice-control:stop')
    const failedStart: unknown = await start?.({ sender: { id: 7 } })
    expect(failedStart).toMatchObject({ ok: false })

    await stop?.({ sender: { id: 7 } }, serviceState.sessionId)
    expect(serviceStopMock).toHaveBeenCalledTimes(1)
  })
})
