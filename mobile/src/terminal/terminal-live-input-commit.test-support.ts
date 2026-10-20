import { createElement, useLayoutEffect, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type TerminalLiveInputCommitHandlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

type TerminalLiveInputCommitHarness = {
  readonly captures: readonly string[]
  readonly getHandlers: () => TerminalLiveInputCommitHandlers
  readonly handlers: TerminalLiveInputCommitHandlers
  readonly sent: readonly string[]
  readonly setActiveHandle: (next: string) => void
  readonly setActiveSessionTabType: (next: string | undefined) => void
  readonly setConnected: (next: boolean) => void
  readonly setSendResult: (next: boolean) => void
  readonly unmount: () => void
}

type TerminalLiveInputCommitHarnessOptions = {
  readonly sendResult?: boolean
  readonly sender?: TerminalLiveInputSender
}

export function createTerminalLiveInputCommitHarness({
  sendResult = true,
  sender
}: TerminalLiveInputCommitHarnessOptions = {}): TerminalLiveInputCommitHarness {
  let activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const captures: string[] = []
  const setLiveInputCapture = (text: string): void => {
    captures.push(text)
  }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set([activeHandle])
  }
  const sent: string[] = []
  let currentSendResult = sendResult
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return sender ? sender(_handle, bytes) : currentSendResult
    }
  }
  // Refs never re-render; only these variables re-run the hook's clear effects.
  let currentActiveSessionTabType: string | undefined = 'terminal'
  let currentConnected = true
  let handlers: TerminalLiveInputCommitHandlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    const currentHandlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: currentActiveSessionTabType,
      activeSessionTabTypeRef,
      connected: currentConnected,
      liveInputRef,
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture
    })
    useLayoutEffect(() => {
      handlers = currentHandlers
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!handlers || !renderer) {
    throw new Error('terminal live input hook did not render')
  }

  return {
    captures,
    getHandlers: () => {
      if (!handlers) {
        throw new Error('terminal live input hook is not mounted')
      }
      return handlers
    },
    handlers,
    sent,
    setActiveHandle: (next: string): void => {
      activeHandle = next
      activeHandleRef.current = next
      liveInputTerminalHandles.add(next)
      liveInputTerminalHandlesRef.current.add(next)
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setActiveSessionTabType: (next: string | undefined): void => {
      currentActiveSessionTabType = next
      // Ref and prop derive from the same activeSessionTab in the real route, so
      // they go null together during tab-list lag — keep the harness coupled.
      activeSessionTabTypeRef.current = next ?? null
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setConnected: (next: boolean): void => {
      currentConnected = next
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setSendResult: (next: boolean): void => {
      currentSendResult = next
    },
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}
