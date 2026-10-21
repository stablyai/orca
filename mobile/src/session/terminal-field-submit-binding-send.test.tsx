// @vitest-environment happy-dom
import { createElement, useEffect, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

/**
 * The page's buffered submit, end to end through the hook that owns it.
 *
 * The census beside this file reads one spelling of a frozen handler. This reads the behaviour, so
 * a `useMemo`, a module-level function or a ref captured once fails it the same way: the hook is
 * rendered first as a session is before its effects land — no client, no handle, nothing sendable —
 * then again as it is after, and the field's bound listener has to reach the second one.
 */
const mocks = vi.hoisted(() => {
  const sent: Array<Record<string, unknown>> = []
  return { sent }
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
      return { ok: true }
    },
    interpret: () => true
  }
}))
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
  // Once, as React attaches a ref whose identity does not change — which is why the handler behind
  // it has to stay current on its own.
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
