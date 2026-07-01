import { createElement, type RefObject } from 'react'
import { renderToString } from 'react-dom/server'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type TerminalLiveInputCommitHarness = {
  readonly captures: readonly string[]
  readonly handlers: ReturnType<typeof useTerminalLiveInputCommit<string>>
  readonly sent: readonly string[]
}

function createTerminalLiveInputCommitHarness(): TerminalLiveInputCommitHarness {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const captures: string[] = []
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = new Set([activeHandle])
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set([activeHandle])
  }
  const sent: string[] = []
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return true
    }
  }
  let handlers: ReturnType<typeof useTerminalLiveInputCommit<string>> | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  renderToString(createElement(Harness))
  if (handlers === null) {
    throw new Error('terminal live input hook did not render')
  }

  return { captures, handlers, sent }
}

describe('terminal live input commit hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Given Hangul pending text When the old idle window elapses Then does not send jamo to the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputChange('ㅎ')
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    expect(captures).toEqual(['ㅎ'])
    expect(sent).toEqual([])
  })

  it('Given Hangul pending text When submit is requested Then sends composed text before carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputSubmit()

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })
})
