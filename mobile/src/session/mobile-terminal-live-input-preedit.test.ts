import { createElement, type RefObject } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import {
  useTerminalLiveInputCommit,
  type TerminalLiveInputChangeEvent
} from '../terminal/use-terminal-live-input-commit'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'

type RecordedChange = {
  readonly text: string
  readonly isComposing: boolean
  readonly replacementText: string
  readonly start: number
  readonly end: number
}

// Captured from a PHYSICAL iPhone 13 Pro Max, iOS 26.5.2, system Japanese Kana
// keyboard, flicking い/う/え/お off the あ key. eventCount 5..10 of a gapless 1..23
// stream, sealed at swarm-scratch/lane-ios/metro.log.
const DEVICE_FLICK_TRACE: readonly RecordedChange[] = [
  { text: 'い', isComposing: true, replacementText: 'い', start: 0, end: 0 },
  { text: 'いう', isComposing: true, replacementText: 'う', start: 1, end: 1 },
  { text: 'いうえ', isComposing: true, replacementText: 'え', start: 2, end: 2 },
  { text: 'いうえお', isComposing: true, replacementText: 'お', start: 3, end: 3 },
  { text: 'いうえお', isComposing: true, replacementText: 'いうえお', start: 0, end: 4 },
  { text: 'いうえお', isComposing: false, replacementText: 'いうえお', start: 0, end: 4 }
]

const ORDINARY_ABC_TRACE: readonly RecordedChange[] = [
  { text: 'a', isComposing: false, replacementText: 'a', start: 0, end: 0 },
  { text: 'ab', isComposing: false, replacementText: 'b', start: 1, end: 1 },
  { text: 'abc', isComposing: false, replacementText: 'c', start: 2, end: 2 }
]

// iOS Korean 2-set never marks: every event reports isComposing:false, so it
// commits continuously and must never enter the preview path.
const IOS_KOREAN_2SET_TRACE: readonly RecordedChange[] = [
  { text: 'ㅇ', isComposing: false, replacementText: 'ㅇ', start: 0, end: 0 },
  { text: '아', isComposing: false, replacementText: 'ㅏ', start: 1, end: 1 },
  { text: '안', isComposing: false, replacementText: 'ㄴ', start: 1, end: 1 }
]

type TraceRun = {
  readonly previews: string[]
  readonly sent: string[]
}

/**
 * Mirrors the production wiring in app/h/[hostId]/session/[worktreeId].tsx. The
 * commit hook owns every send decision; a sibling flag mirrors the native
 * marked-text bit into state so the dock can render a preview. Passing
 * `withPreviewWiring: false` reproduces the pre-fix behavior for comparison.
 */
function runTrace(trace: readonly RecordedChange[], withPreviewWiring = true): TraceRun {
  const activeHandle = 'terminal-a'
  const sent: string[] = []
  const previews: string[] = []
  let capture = ''
  let composing = false
  const liveInputTerminalHandles = new Set([activeHandle])
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return true
    }
  }
  let onChange: ((event: TerminalLiveInputChangeEvent) => void) | null = null

  function Harness(): null {
    const { handleLiveInputChange } = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef: { current: activeHandle },
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef: { current: 'terminal' },
      connected: true,
      liveInputRef: { current: { setNativeProps: vi.fn() } },
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef: { current: liveInputTerminalHandles },
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => {
        capture = text
      }
    })
    onChange = (event) => {
      if (withPreviewWiring) {
        composing = event.nativeEvent.isComposing === true
      }
      handleLiveInputChange(event)
    }
    return null
  }

  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    act(() => {
      create(createElement(Harness))
    })
    for (const change of trace) {
      act(() => {
        onChange?.({
          nativeEvent: {
            text: change.text,
            isComposing: change.isComposing,
            replacementText: change.replacementText,
            replacementRange: { start: change.start, end: change.end }
          }
        })
      })
      previews.push(renderPreview(composing ? capture : ''))
    }
  } finally {
    consoleError.mockRestore()
  }
  return { previews, sent }
}

/** Renders the real dock component and returns the visible composing text. */
function renderPreview(composingText: string): string {
  let tree: ReturnType<typeof create> | null = null
  act(() => {
    tree = create(
      createElement(MobileTerminalLiveInputStatus, {
        dictation: { isStarting: false, isRecording: false, isProcessing: false },
        isAttaching: false,
        composingText
      })
    )
  })
  const texts = tree!.root.findAllByType('Text')
  const isComposingView = texts.some((t) => t.props.children === 'Composing')
  return isComposingView ? String(texts[1]?.props.children ?? '') : ''
}

describe('mobile terminal live-input preedit preview', () => {
  it('renders the composing text for the recorded physical-device flick trace', async () => {
    const { previews, sent } = runTrace(DEVICE_FLICK_TRACE)

    // THE DISPLAY DEFECT: these four states were invisible before the fix.
    expect(previews.slice(0, 4)).toEqual(['い', 'いう', 'いうえ', 'いうえお'])
    // The commit event clears the preview; the terminal echo takes over.
    expect(previews.at(-1)).toBe('')
    // Byte behavior unchanged: nothing reaches the PTY until the unmarked commit.
    await vi.waitFor(() => expect(sent).toEqual(['いうえお']))
  })

  it('sends nothing while composing, for the same recorded trace', async () => {
    const marked = DEVICE_FLICK_TRACE.slice(0, 5)
    const { sent } = runTrace(marked)

    // Five marked events, zero bytes. This is the byte-level form of the
    // reporter's observation that nothing appeared in the terminal until commit.
    await vi.waitFor(() => expect(sent).toEqual([]))
  })

  it('shows no preview for ordinary ASCII and leaves its bytes untouched', async () => {
    const withFix = runTrace(ORDINARY_ABC_TRACE)
    const withoutFix = runTrace(ORDINARY_ABC_TRACE, false)

    expect(withFix.previews).toEqual(['', '', ''])
    await vi.waitFor(() => expect(withFix.sent).toEqual(withoutFix.sent))
    await vi.waitFor(() => expect(withFix.sent.join('')).toBe('abc'))
  })

  it('shows no preview for iOS Korean 2-set, which never marks', async () => {
    const withFix = runTrace(IOS_KOREAN_2SET_TRACE)
    const withoutFix = runTrace(IOS_KOREAN_2SET_TRACE, false)

    // The exemption: unmarked input never enters the preview path, so this
    // surface behaves exactly as it did before the fix.
    expect(withFix.previews).toEqual(['', '', ''])
    await vi.waitFor(() => expect(withFix.sent).toEqual(withoutFix.sent))
  })
})
