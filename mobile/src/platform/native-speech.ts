import {
  BRIDGE_SPEECH_FAILURES,
  speechParamsSchema,
  type BridgeSpeechFailure,
  type BridgeSpeechRead,
  type DictationEnginePreference
} from '../mobile-web-shell/bridge/bridge-speech-verbs'

// The shell side of native.speech.act. The recognizer itself lives in the native audio module; this keeps its events between the page's polls.

export type NativeSpeechEngine = {
  readonly availability: (
    locale: string
  ) => Promise<{ status: 'ready' | 'needs-download' | 'unsupported'; locale: string | null }>
  readonly start: (
    locale: string
  ) => Promise<{ started: true; locale: string } | { started: false; reason: string }>
  readonly finish: () => Promise<string>
  readonly cancel: () => void
  readonly readPreference: () => Promise<DictationEnginePreference>
  readonly onText: (handler: (text: Omit<BridgeSpeechRead, 'failure'>) => void) => void
  readonly onError: (handler: (code: string) => void) => void
}

export type NativeSpeechServer = {
  readonly serve: (params: unknown) => Promise<unknown>
  // This phone promises audio never reaches the computer; only a page whose recognizer is armed may open the mic. Older pages stream to the computer and are refused.
  readonly mayCapture: () => Promise<boolean>
  readonly dispose: () => void
}

type Session = { text: Omit<BridgeSpeechRead, 'failure'>; failure: BridgeSpeechFailure | null }

// The recognizer is one per phone, so its live session is per engine; each server holds only its own.
type EngineState = { live: Session | null }

const engineStates = new WeakMap<NativeSpeechEngine, EngineState>()

// A newer engine's code the shipped page does not know still means "use the computer".
function failureOf(code: string): BridgeSpeechFailure {
  return BRIDGE_SPEECH_FAILURES.find((known) => known === code) ?? 'failed'
}

function engineState(engine: NativeSpeechEngine): EngineState {
  const known = engineStates.get(engine)
  if (known !== undefined) {
    return known
  }
  const state: EngineState = { live: null }
  engineStates.set(engine, state)
  // Subscribed once per engine for the app's life, so no page session can miss or double an event.
  engine.onText((text) => {
    if (state.live !== null && text.revision > state.live.text.revision) {
      state.live.text = text
    }
  })
  engine.onError((code) => {
    if (state.live !== null) {
      state.live.failure ??= failureOf(code)
    }
  })
  return state
}

export function createNativeSpeechServer(engine: NativeSpeechEngine): NativeSpeechServer {
  const shared = engineState(engine)
  let session: Session | null = null

  // Another page's start takes the recognizer; this session is then over.
  function owned(): Session | null {
    return session !== null && session === shared.live ? session : null
  }

  function endSession(): void {
    if (owned() !== null) {
      shared.live = null
      engine.cancel()
    }
    session = null
  }

  async function status(locale: string): Promise<unknown> {
    // Answer the preference even when the recognizer can't say, so This phone never falls to the computer.
    const [preference, available] = await Promise.all([
      engine.readPreference(),
      engine.availability(locale).catch(() => null)
    ])
    return available === null
      ? { status: 'unsupported', locale: null, preference }
      : { status: available.status, locale: available.locale, preference }
  }

  async function start(locale: string): Promise<unknown> {
    endSession()
    // Claim before the await so events from the moment native arms land here; the engine's own start replaces any other page's session.
    const claimed: Session = { text: { revision: 0, committed: '', tentative: '' }, failure: null }
    session = claimed
    shared.live = claimed
    const started = await engine
      .start(locale)
      .catch(() => ({ started: false as const, reason: 'failed' }))
    const kept = session === claimed && shared.live === claimed
    // Cancelled while arming: stop what native armed, unless another page's start already replaced it.
    if (started.started && !kept && (shared.live === null || shared.live === claimed)) {
      engine.cancel()
    }
    if (!started.started || !kept) {
      if (shared.live === claimed) {
        shared.live = null
      }
      if (session === claimed) {
        session = null
      }
      return {
        started: false,
        locale: null,
        reason: started.started ? 'busy' : failureOf(started.reason)
      }
    }
    return { started: true, locale: started.locale, reason: null }
  }

  function read(): unknown {
    const live = owned()
    // No session here means it was lost or taken; the page falls back to the computer.
    if (live === null) {
      return { revision: 0, committed: '', tentative: '', failure: 'failed' }
    }
    return { ...live.text, failure: live.failure }
  }

  async function finish(): Promise<unknown> {
    const live = owned()
    if (live === null) {
      return { text: null, failure: 'failed' }
    }
    try {
      const text = await engine.finish()
      return live.failure === null ? { text, failure: null } : { text: null, failure: live.failure }
    } catch {
      return { text: null, failure: live.failure ?? 'failed' }
    } finally {
      if (shared.live === live) {
        shared.live = null
      }
      if (session === live) {
        session = null
      }
    }
  }

  return {
    serve: async (params) => {
      const call = speechParamsSchema.parse(params)
      switch (call.action) {
        case 'status':
          return status(call.locale)
        case 'start':
          return start(call.locale)
        case 'read':
          return read()
        case 'finish':
          return finish()
        case 'cancel':
          endSession()
          return {}
      }
    },
    mayCapture: async () => owned() !== null || (await engine.readPreference()) !== 'phone',
    dispose: endSession
  }
}
