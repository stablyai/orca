// @vitest-environment happy-dom
import { createElement, useEffect, useRef, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

// Bind once before the client/handle arrives, then dispatch after rerender to prove the frozen field listener reads current send state.
const mocks = vi.hoisted(() => {
  const sent: Array<Record<string, unknown>> = []
  return { sent, acknowledge: async () => {} }
})

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn(), addListener: () => ({ remove: vi.fn() }) }
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerMediumImpact: vi.fn() }))
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))
vi.mock('../terminal/mobile-terminal-operations', () => ({
  terminalInputSend: {
    request: async (_client: unknown, params: Record<string, unknown>) => {
      mocks.sent.push(params)
      await mocks.acknowledge()
      return { ok: true }
    },
    interpret: () => true
  }
}))
vi.mock('../platform/host-os', () => ({ hostOs: () => 'android' }))

// The page's own sibling, because the listener this test dispatches to only exists there.
vi.mock(
  '../terminal/terminal-text-field-submit-binding',
  async () => await import('../terminal/terminal-text-field-submit-binding.web')
)

type Session = {
  readonly client: unknown
  readonly activeHandle: string | null
  readonly canSend: boolean
  readonly draft: string
}

const OFFLINE: Session = { client: null, activeHandle: null, canSend: false, draft: '' }
const READY: Session = {
  client: { getState: () => 'connected' },
  activeHandle: 'terminal-a',
  canSend: true,
  draft: 'ls -la'
}

const field = document.createElement('input')
let restoredDrafts: string[] = []

function buildScope(session: Session): MobileSessionTerminalWebviewModel {
  const noop = (): void => {}
  const scope = {
    client: session.client,
    activeHandle: session.activeHandle,
    activeSessionTab: null,
    setActionTarget: noop,
    setMarkdownActionTarget: noop,
    setFileActionTarget: noop,
    setBrowserActionTarget: noop,
    setAgentSessionActionTarget: noop,
    keyboardHeight: 0,
    deviceTokenRef: { current: null },
    clientRef: { current: session.client },
    connStateRef: { current: 'connected' },
    liveInputRef: { current: null },
    commandInputRef: { current: null },
    liveInputFocusTimerRef: { current: null },
    sendLiveTerminalInputRef: { current: async () => true },
    sessionTabActionSheetKeyboardHideSubRef: { current: null },
    sessionTabActionSheetRequestSeqRef: { current: 0 },
    activeHandleRef: { current: session.activeHandle },
    activeSessionTabTypeRef: { current: 'terminal' },
    sendingRef: { current: false },
    bufferedTerminalDraftState: {
      input: session.draft,
      beginBufferedTerminalDraftSend: (handle: string, draft: string) => ({
        draft,
        handle,
        token: { handle }
      }),
      restoreRejectedDraft: (send: { draft: string }) => restoredDrafts.push(send.draft),
      settleBufferedTerminalDraftSend: () => true
    },
    getSendCompletionGeneration: () => 0,
    getLiveInteractionGeneration: () => 0,
    handleLiveInputAccessoryBytes: async () => ({ kind: 'allow-raw' }),
    handleLiveInputSubmit: async () => true,
    canSend: session.canSend,
    scheduleDelayedAction: noop,
    showToast: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures exactly the keys above, which the census beside this file pins; nothing else on the model is reachable from the submit path under test.
  return scope as unknown as MobileSessionTerminalWebviewModel
}

function Harness({ session }: { readonly session: Session }): null {
  const { bindCommandField } = useMobileSessionTerminalSendActions(buildScope(session))
  // Keep ref identity stable as React does; the bound handler must update independently.
  useEffect(() => {
    bindCommandField(fieldAsTextInput)
  }, [bindCommandField])
  return null
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: on React Native Web a TextInput ref is the DOM node, which is what the page's binding reads and what this dispatches on.
const fieldAsTextInput = field as unknown as RefObject<never>['current']

describe('the buffered field submit the page binds', () => {
  it('reaches a handleSend that can send, not the one the first render had', () => {
    mocks.sent.length = 0
    restoredDrafts = []
    let renderer: ReactTestRenderer | null = null

    act(() => {
      renderer = create(createElement(Harness, { session: OFFLINE }))
    })
    act(() => {
      renderer?.update(createElement(Harness, { session: READY }))
    })
    act(() => {
      field.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertLineBreak'
        })
      )
    })

    expect(mocks.sent).toHaveLength(1)
    expect(mocks.sent[0]).toMatchObject({ terminal: 'terminal-a', text: 'ls -la', enter: true })
    act(() => renderer?.unmount())
  })
})

let changeLiveText: (text: string) => void = () => {}
const liveField = Object.assign(document.createElement('input'), {
  setNativeProps: ({ text }: { text: string }) => {
    liveField.value = text
  }
})
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RNWeb TextInput refs are DOM nodes; the binding validates the actual node before installing listeners.
const liveFieldRef = liveField as unknown as RefObject<never>['current']

function LiveHarness({ session }: { readonly session: Session }): null {
  const current = buildScope(session)
  const refs = useRef(current).current
  const liveHandles = useRef(new Set<string>())
  const sender = useRef<TerminalLiveInputSender>(async () => false)
  const handle = session.activeHandle
  refs.activeHandleRef.current = handle
  refs.activeSessionTabTypeRef.current = 'terminal'
  refs.connStateRef.current = session.canSend ? 'connected' : 'disconnected'
  refs.clientRef.current = current.client
  liveHandles.current = new Set(handle ? [handle] : [])
  const commit = useTerminalLiveInputCommit({
    activeHandle: handle,
    activeHandleRef: refs.activeHandleRef,
    activeSessionTabType: 'terminal',
    activeSessionTabTypeRef: refs.activeSessionTabTypeRef,
    connected: session.canSend,
    liveInputRef: refs.liveInputRef,
    liveInputTerminalHandles: liveHandles.current,
    liveInputTerminalHandlesRef: liveHandles,
    sendLiveTerminalInputRef: sender,
    setLiveInputCapture: () => {}
  })
  const actions = useMobileSessionTerminalSendActions({
    ...refs,
    ...commit,
    client: current.client,
    activeHandle: handle,
    canSend: session.canSend,
    sendLiveTerminalInputRef: sender
  })
  changeLiveText = (text) =>
    commit.handleLiveInputChange({ nativeEvent: { text, isComposing: false } })
  useEffect(() => {
    actions.bindLiveInputField(liveFieldRef)
    return () => actions.bindLiveInputField(null)
  }, [actions.bindLiveInputField])
  return null
}

function pressControl(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  })
  liveField.dispatchEvent(event)
  return event
}

function holdAcknowledgement(): () => void {
  let release = (): void => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.acknowledge = () => pending
  return () => {
    mocks.acknowledge = async () => {}
    release()
  }
}

describe('keyboard controls through the live pending-text queue', () => {
  it('sends the control once only after pending text is acknowledged', async () => {
    mocks.sent.length = 0
    const release = holdAcknowledgement()
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(createElement(LiveHarness, { session: READY }))
    })
    await act(async () => {
      changeLiveText('hello')
      expect(pressControl().defaultPrevented).toBe(true)
    })
    expect(mocks.sent.map((send) => send.text)).toEqual(['hello'])
    await act(async () => {
      release()
    })
    expect(mocks.sent.map((send) => send.text)).toEqual(['hello', '\x03'])
    act(() => renderer?.unmount())
    expect(pressControl().defaultPrevented).toBe(false)
  })

  it.each(['terminal switch', 'disconnect and reconnect'] as const)(
    'drops a queued control after %s even when the original terminal returns',
    async (change) => {
      mocks.sent.length = 0
      const release = holdAcknowledgement()
      let renderer: ReactTestRenderer | null = null
      await act(async () => {
        renderer = create(createElement(LiveHarness, { session: READY }))
      })
      await act(async () => {
        changeLiveText('hello')
        pressControl()
      })
      const changed =
        change === 'terminal switch' ? { ...READY, activeHandle: 'terminal-b' } : OFFLINE
      await act(async () => {
        renderer?.update(createElement(LiveHarness, { session: changed }))
      })
      await act(async () => {
        renderer?.update(createElement(LiveHarness, { session: READY }))
      })
      await act(async () => {
        release()
      })
      expect(mocks.sent.map((send) => send.text)).toEqual(['hello'])
      await act(async () => {
        pressControl()
      })
      expect(mocks.sent.map((send) => send.text)).toEqual(['hello', '\x03'])
      act(() => renderer?.unmount())
    }
  )
})
