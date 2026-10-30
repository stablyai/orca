// Drive real page capture/bridge/shell handlers to prove granted routes record and ungranted routes report refusal then recover.
import { createElement, type ReactElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Use host elements to observe control labels and handlers without importing native runtime.
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  ActivityIndicator: (props: Record<string, unknown>) =>
    createElement('rn-activity-indicator', props),
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
  Pressable: (props: { children?: ReactNode }) =>
    createElement('rn-pressable', props, props.children)
}))
vi.mock('lucide-react-native', () => ({
  ImagePlus: (props: Record<string, unknown>) => createElement('lucide-image-plus', props),
  Mic: (props: Record<string, unknown>) => createElement('lucide-mic', props)
}))

vi.mock(
  '../platform/dictation-capture',
  async () => await import('../platform/dictation-capture.web')
)

// Stub re-exported hooks to keep Expo out of this runtime.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createNativeAudioCapture, type NativeAudioEngine } from '../platform/native-audio'
import { useMobileDictation } from '../hooks/use-mobile-dictation'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'

const reported: string[] = []

const screen: string[] = []

function createAudioShell(): (verb: BridgeNativeVerb, params: unknown) => Promise<unknown> {
  const engine: NativeAudioEngine = {
    requestPermission: async () => 'granted',
    open: async (sampleRate) => ({ opened: true, sampleRate }),
    begin: () => true,
    end: () => {},
    onMicrophoneData: () => ({ remove: () => {} }),
    onInterruption: () => ({ remove: () => {} }),
    screenLock: {
      hold: () => screen.push('+'),
      release: () => screen.push('-')
    }
  }
  const capture = createNativeAudioCapture(engine)
  return (verb, params) => capture.serve(verb, params)
}

// Expose starting-state cancel, which the rendered button cannot offer yet.
const composer: { dictation: ReturnType<typeof useMobileDictation> | null } = { dictation: null }

function Composer({ pair }: { pair: BridgePortPair }): ReactElement {
  const dictation = useMobileDictation({
    client: pair.client,
    enabled: true,
    onTranscript: () => {},
    onError: (error) => reported.push(error.message)
  })
  composer.dictation = dictation
  return (
    <MobileTerminalInputActions
      canSend
      isAttaching={false}
      dictation={dictation}
      dictationMode="toggle"
      buttonStyle={null}
      activeButtonStyle={null}
      disabledButtonStyle={null}
      onAttachImage={() => {}}
      onAttachFile={() => {}}
      onDictationToggle={() => {
        // Use the composer’s catch path so bridge refusal becomes feedback rather than an unhandled rejection.
        void dictation.start().catch((error: unknown) => {
          reported.push(error instanceof Error ? error.message : String(error))
        })
      }}
      onDictationPressIn={() => {}}
      onDictationPressOut={() => {}}
      onDictationCancel={() => {
        void dictation.cancel()
      }}
    />
  )
}

type DesktopReply = {
  id: string
  ok: boolean
  result?: unknown
  error?: unknown
}
type DesktopAnswer = (method: string) => DesktopReply | null

const DESKTOP_OK: DesktopAnswer = () => ({ id: 'desktop', ok: true, result: {} })

const pending: { method: string; resolve: (reply: DesktopReply) => void }[] = []

type MicControl = {
  readonly label: () => string
  readonly tap: (answer?: DesktopAnswer) => Promise<void>
  readonly settle: (answer?: DesktopAnswer) => Promise<void>
}

function micOf(root: ReactTestInstance): ReactTestInstance {
  const found = root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.includes('voice dictation')
  )
  const mic = found[0]
  if (found.length !== 1 || mic === undefined) {
    throw new Error(`expected one mic control, found ${found.length}`)
  }
  return mic
}

async function mount(pair: BridgePortPair): Promise<MicControl> {
  await pair.flush()
  const held: { tree: ReturnType<typeof create> | null } = { tree: null }
  await act(async () => {
    held.tree = create(
      <RpcClientProvider client={pair.client}>
        <Composer pair={pair} />
      </RpcClientProvider>
    )
  })
  const rendered = held.tree
  if (rendered === null) {
    throw new Error('nothing mounted')
  }
  async function settle(answer: DesktopAnswer = DESKTOP_OK): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        await pair.flush()
        for (const request of pair.rpc.requests.splice(0)) {
          const reply = answer(request.method)
          if (reply === null) {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake client's resolver takes the reply shape the host would have sent.
            pending.push({ method: request.method, resolve: request.resolve as never })
            continue
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake client takes the reply shape the host would have sent, which is what a case builds here.
          request.resolve(reply as never)
        }
        await pair.flush()
      })
    }
  }

  return {
    label: () => String(micOf(rendered.root).props.accessibilityLabel),
    settle,
    tap: async (answer: DesktopAnswer = DESKTOP_OK) => {
      await act(async () => {
        micOf(rendered.root).props.onPress()
      })
      await settle(answer)
    }
  }
}

beforeEach(() => {
  reported.length = 0
  screen.length = 0
  pending.length = 0
  composer.dictation = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the mic control on a page the shell did not grant audio', () => {
  it('reports the shell refusal and comes back to its resting label', async () => {
    const pair = createFakeBridgePortPair({
      serveNativeVerb: createAudioShell(),
      routeGrants: ['navigate', 'storage']
    })
    const mic = await mount(pair)
    expect(mic.label()).toBe('Start voice dictation')
    await mic.tap()
    expect(reported).toEqual(['this shell did not grant native.audio.start'])
    expect(mic.label()).toBe('Start voice dictation')
  })

  it('sends no frame for a verb it was never granted', async () => {
    const pair = createFakeBridgePortPair({
      serveNativeVerb: createAudioShell(),
      routeGrants: ['navigate', 'storage']
    })
    const mic = await mount(pair)
    await mic.tap()
    expect(
      pair
        .readToShell()
        .filter((frame) => frame.type === 'request' && frame.method.startsWith('native.audio.'))
    ).toEqual([])
  })
})

describe('a page whose desktop start fails after the microphone opened', () => {
  // The mic opens before desktop start; desktop refusal must close capture and release the shell wake lock.
  it('closes the shell capture and gives the screen back', async () => {
    const shell = createAudioShell()
    const verbs: string[] = []
    const pair = createFakeBridgePortPair({
      serveNativeVerb: (verb, params) => {
        verbs.push(verb)
        return shell(verb, params)
      }
    })
    const mic = await mount(pair)
    await mic.tap((method) =>
      method === 'speech.dictation.start'
        ? { id: 'desktop', ok: false, error: { code: 'refused', message: 'no model installed' } }
        : { id: 'desktop', ok: true, result: {} }
    )
    expect(verbs).toContain('native.audio.start')
    expect(verbs).toContain('native.audio.stop')
    expect(screen).toEqual(['+', '-'])
    expect(reported).not.toEqual([])
    expect(mic.label()).toBe('Start voice dictation')
  })
})

describe('the mic control on a page the shell did grant audio', () => {
  it('reaches recording, with no refusal reported', async () => {
    const pair = createFakeBridgePortPair({ serveNativeVerb: createAudioShell() })
    const mic = await mount(pair)
    expect(mic.label()).toBe('Start voice dictation')
    await mic.tap()
    expect(reported).toEqual([])
    expect(mic.label()).toBe('Stop voice dictation')
  })

  it('opens the capture through the shell, and asks it for nothing else', async () => {
    const pair = createFakeBridgePortPair({ serveNativeVerb: createAudioShell() })
    const mic = await mount(pair)
    await mic.tap()
    const verbs = pair
      .readToShell()
      .flatMap((frame) =>
        frame.type === 'request' && frame.method.startsWith('native.') ? [frame.method] : []
      )
    expect(verbs).toContain('native.audio.start')
    expect(verbs.every((verb) => verb.startsWith('native.audio.'))).toBe(true)
    expect(
      pair
        .readToShell()
        .some((frame) => frame.type === 'request' && frame.method.startsWith('speech.dictation.'))
    ).toBe(true)
  })
})

describe('a stale page start whose refusal arrives after a newer one is recording', () => {
  it('leaves the newer dictation recording, with the shell capture and the screen still its own', async () => {
    const shell = createAudioShell()
    const verbs: string[] = []
    const pair = createFakeBridgePortPair({
      serveNativeVerb: (verb, params) => {
        verbs.push(verb)
        return shell(verb, params)
      }
    })
    const mic = await mount(pair)
    await mic.tap((method) => (method === 'speech.dictation.start' ? null : DESKTOP_OK(method)))
    expect(screen).toEqual(['+'])
    const first = pending.find((request) => request.method === 'speech.dictation.start')
    expect(first).toBeDefined()
    await act(async () => {
      void composer.dictation?.cancel()
    })
    await mic.settle()
    await mic.tap()
    expect(mic.label()).toBe('Stop voice dictation')
    const verbsWhileRecording = [...verbs]
    const screenWhileRecording = [...screen]
    // A’s late failure must not close B’s capture or wake lock.
    await act(async () => {
      first?.resolve({ id: 'desktop', ok: false, error: { code: 'refused', message: 'no model' } })
    })
    await mic.settle()
    expect(mic.label()).toBe('Stop voice dictation')
    expect(verbs).toEqual(verbsWhileRecording)
    expect(screen).toEqual(screenWhileRecording)
  })
})
