import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { VoiceControlServiceDeps } from '../voice-control/voice-control-service'
import { voiceControlTranscriptLogPath } from '../voice-control/voice-control-transcript-log'

type IpcHandler = (event: { sender: { id: number } }, ...args: any[]) => unknown
const handlers = new Map<string, IpcHandler>()
const resumeHandlers: (() => void)[] = []

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
    powerMonitor: {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === 'resume') {
          resumeHandlers.push(callback)
        }
      })
    },
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
// Captured at construction so tests can drive the wiring-level deps directly.
let serviceDepsCapture: VoiceControlServiceDeps | null = null

vi.mock('../voice-control/voice-control-service', () => ({
  VoiceControlService: class {
    constructor(deps: VoiceControlServiceDeps) {
      serviceDepsCapture = deps
    }
    getState() {
      return { ...serviceState }
    }
    start = serviceStartMock
    stop = serviceStopMock
    exchangeSdp = vi.fn()
  }
}))

import { registerVoiceControlHandlers } from './voice-control'

function fakeSender(id: number) {
  return { id, send: vi.fn(), isDestroyed: () => false }
}

function register(): void {
  handlers.clear()
  serviceState.state = 'idle'
  serviceState.sessionId = null
  serviceStartMock.mockReset()
  serviceStopMock.mockClear()
  const store = { getSettings: () => ({ voice: {} }) }
  const runtime = {
    getWorktreePs: async () => ({ worktrees: [] }),
    // The dormant watcher's pump seam: a mailbox that never wakes on its own.
    getOrchestrationDb: () => ({
      getRun: () => null,
      getOrCreateRunDelivery: () => undefined,
      acknowledgeRunDelivery: () => undefined
    }),
    waitForMessage: () => new Promise(() => {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only getSettings().voice.control, getWorktreePs(), and the dormant-watch pump seam above; the full Store/Runtime surface is fixture weight.
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

describe('power resume', () => {
  beforeEach(() => {
    resumeHandlers.length = 0
    register()
  })

  it('stops the dead session, pings the owner to restart, and releases ownership', async () => {
    serviceStartMock.mockImplementation(async (sessionId: string) => {
      serviceState.state = 'live'
      serviceState.sessionId = sessionId
      return null
    })
    const owner = fakeSender(7)
    await handlers.get('voice-control:start')?.({ sender: owner })
    expect(resumeHandlers).toHaveLength(1)

    resumeHandlers[0]!()
    await vi.waitFor(() => {
      expect(serviceStopMock).toHaveBeenCalledWith('power-resume')
    })
    await vi.waitFor(() => {
      expect(owner.send).toHaveBeenCalledWith('voice-control:systemResume', {})
    })

    // Ownership was released: a restart from the same window re-claims it, and the next
    // resume pings that same sender again rather than a stale slot.
    serviceStopMock.mockClear()
    await handlers.get('voice-control:start')?.({ sender: owner })
    resumeHandlers[0]!()
    await vi.waitFor(() => {
      expect(owner.send).toHaveBeenCalledTimes(2)
    })
  })

  it('ignores a resume while nothing is running', async () => {
    expect(resumeHandlers).toHaveLength(1)
    resumeHandlers[0]!()
    await Promise.resolve()
    expect(serviceStopMock).not.toHaveBeenCalled()
  })
})

describe('wake-on-reply recipient', () => {
  beforeEach(register)

  async function startAndOpenDormantWatcher(owner: ReturnType<typeof fakeSender>) {
    serviceStartMock.mockImplementation(async (sessionId: string) => {
      serviceState.state = 'live'
      serviceState.sessionId = sessionId
      return null
    })
    const started: unknown = await handlers.get('voice-control:start')?.({ sender: owner })
    expect(started).toMatchObject({ ok: true })
    const deps = serviceDepsCapture
    if (!deps?.openDormantWatcher) {
      throw new Error('service deps were not captured')
    }
    // What the service does inside stop() when work is outstanding: open the watcher
    // while the owner slot is still set.
    deps.openDormantWatcher('run-1', () => {})
    await handlers.get('voice-control:stop')?.({ sender: { id: 7 } }, serviceState.sessionId)
    return deps
  }

  // Live failure this guards: stop with outstanding work released the owner slot, so the
  // reply's wake event was sent to no one and the promised spoken update never happened.
  it('the wake reaches the owner window even after stop released ownership', async () => {
    const owner = fakeSender(7)
    const deps = await startAndOpenDormantWatcher(owner)

    deps.emitWakeForReply?.()
    expect(owner.send).toHaveBeenCalledWith('voice-control:wakeForReply', {})
  })

  it('drops the wake when the window that dispatched the work is gone', async () => {
    const owner = fakeSender(7)
    let destroyed = false
    owner.isDestroyed = () => destroyed
    const deps = await startAndOpenDormantWatcher(owner)

    destroyed = true
    deps.emitWakeForReply?.()
    expect(owner.send).not.toHaveBeenCalledWith('voice-control:wakeForReply', {})
  })
})

describe('typed-input transcript privacy', () => {
  beforeEach(register)

  it('persists a placeholder for typed text while the live feed keeps the real text', async () => {
    serviceStartMock.mockImplementation(async (sessionId: string) => {
      serviceState.state = 'live'
      serviceState.sessionId = sessionId
      return null
    })
    const owner = fakeSender(7)
    await handlers.get('voice-control:start')?.({ sender: owner })
    const deps = serviceDepsCapture
    if (!deps) {
      throw new Error('service deps were not captured')
    }

    const secret = `s3cret-${randomUUID()}`
    deps.recordTranscript({ ts: 1, kind: 'user', text: secret }, { durableText: '(typed message)' })

    // The live panel gets the real text…
    expect(owner.send).toHaveBeenCalledWith('voice-control:transcriptEntry', {
      ts: 1,
      kind: 'user',
      text: secret
    })
    // …but the durable log keeps only the placeholder — a pasted token must not sit on
    // disk or be replayed into a later session's instructions.
    const logText = readFileSync(voiceControlTranscriptLogPath(tmpdir()), 'utf8')
    const lastLine = logText.trim().split('\n').at(-1) ?? ''
    expect(JSON.parse(lastLine)).toMatchObject({ kind: 'user', text: '(typed message)' })
    expect(logText).not.toContain(secret)
  })
})
