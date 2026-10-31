import { terminalInputSend } from '../terminal/mobile-terminal-operations'
// @vitest-environment happy-dom
import { createElement, useEffect, useRef, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostOs } from '../platform/host-os'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'
import type { TerminalModes } from '../terminal/terminal-webview-contract'

const mocks = vi.hoisted(() => {
  const sent: Array<Record<string, unknown>> = []
  return { sent, acknowledge: async () => {} }
})

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn(), addListener: () => ({ remove: vi.fn() }) }
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerMediumImpact: vi.fn() }))
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
vi.mock('../platform/host-os', () => ({ hostOs: vi.fn(() => 'android') }))

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
  readonly modes?: TerminalModes
}

const OFFLINE: Session = { client: null, activeHandle: null, canSend: false, draft: '' }
const READY: Session = {
  client: { getState: () => 'connected' },
  activeHandle: 'terminal-a',
  canSend: true,
  draft: 'ls -la'
}

let restoredDrafts: string[] = []

function buildScope(session: Session): MobileSessionTerminalWebviewModel {
  const noop = (): void => {}
  const scope = {
    sendTerminalUserInput: terminalInputSend.request,
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
    ptyModesRef: {
      current: new Map(
        session.activeHandle && session.modes ? [[session.activeHandle, session.modes]] : []
      )
    },
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
  changeLiveText = (text) => {
    liveField.value = text
    commit.handleLiveInputChange({ nativeEvent: { text, isComposing: false } })
  }
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

function pressEnter(): void {
  liveField.dispatchEvent(
    new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak' })
  )
}

function pressShiftEnter(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
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

describe.each(['android', 'ios'] as const)('the %s live pending-text queue', (os) => {
  beforeEach(() => {
    vi.mocked(hostOs).mockReturnValue(os)
  })

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

  it.each([
    { key: 'Ctrl-C', press: pressControl, fieldAfter: 'hellox', bytes: '\x03' },
    { key: 'Shift+Enter (legacy)', press: pressShiftEnter, fieldAfter: 'x', bytes: '\x1b\r' },
    {
      key: 'Shift+Enter (Kitty)',
      press: pressShiftEnter,
      fieldAfter: 'x',
      bytes: '\x1b[13;2u',
      kittyKeyboardFlags: 1
    },
    {
      key: 'Shift+Enter (modifyOtherKeys)',
      press: pressShiftEnter,
      fieldAfter: 'x',
      bytes: '\x1b[27;2;13~',
      modifyOtherKeys: 2
    },
    { key: 'Enter', press: pressEnter, fieldAfter: 'x', bytes: '\r' }
  ])(
    'keeps text typed right after $key behind it',
    async ({ press, fieldAfter, bytes, kittyKeyboardFlags = 0, modifyOtherKeys = 0 }) => {
      mocks.sent.length = 0
      const release = holdAcknowledgement()
      let renderer: ReactTestRenderer | null = null
      let fieldAfterControl = ''
      await act(async () => {
        renderer = create(
          createElement(LiveHarness, {
            session: {
              ...READY,
              modes: {
                bracketedPasteMode: false,
                altScreen: false,
                mouseTrackingMode: 'none',
                sgrMouseMode: false,
                sgrMousePixelsMode: false,
                applicationCursorKeysMode: false,
                kittyKeyboardFlags,
                modifyOtherKeys
              }
            }
          })
        )
      })
      await act(async () => {
        changeLiveText('hello')
        press()
        fieldAfterControl = liveField.value
        changeLiveText(fieldAfter)
      })
      await act(async () => {
        release()
      })
      act(() => renderer?.unmount())
      expect(mocks.sent.map((send) => send.text).join('')).toBe(`hello${bytes}x`)
      expect(fieldAfterControl).toBe(fieldAfter === 'x' ? '' : 'hello')
    }
  )

  it.each([
    { key: 'Ctrl-C', press: pressControl, change: 'terminal switch' },
    { key: 'Ctrl-C', press: pressControl, change: 'disconnect and reconnect' },
    { key: 'Enter', press: pressEnter, change: 'terminal switch' }
  ] as const)(
    'drops a queued $key after $change even when the original terminal returns',
    async ({ press, change }) => {
      mocks.sent.length = 0
      const release = holdAcknowledgement()
      let renderer: ReactTestRenderer | null = null
      await act(async () => {
        renderer = create(createElement(LiveHarness, { session: READY }))
      })
      await act(async () => {
        changeLiveText('hello')
        press()
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
