import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows
} from '../../../../../src/shared/native-chat-reply-reveals'
import { NATIVE_CHAT_TEXT_REVEAL_DELAY_MS } from '../../../../../src/shared/native-chat-text-reveal'
import {
  MobileNativeChatReplyRevealsContext,
  type MobileNativeChatReplyReveals
} from './mobile-native-chat-reply-reveals'
import {
  createMobileNativeChatGrowthHold,
  MobileNativeChatGrowthHoldContext
} from '../../mobile-native-chat-growth-hold'

vi.mock('react-native', () => ({
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', Check: 'Check' }))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn() })
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('./MobileNativeChatReasoningRow', () => ({ MobileNativeChatReasoningRow: 'Reasoning' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'TurnStatus' }))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

const DELAY = NATIVE_CHAT_TEXT_REVEAL_DELAY_MS
const first = 'word '.repeat(40)
const second = first + 'more '.repeat(40)

describe('a growing reply on the phone', () => {
  let renderer: ReactTestRenderer | undefined
  let chat: MobileNativeChatReplyReveals
  let growth = createMobileNativeChatGrowthHold()

  function render(text: string | string[], working = true, runningTool = false): void {
    const message: NativeChatMessage = {
      id: 'a1',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: (typeof text === 'string' ? [text] : text).map((part) => ({
        type: 'text',
        text: part
      }))
    }
    if (runningTool) {
      message.blocks.push({ type: 'tool-call', name: 'Read', input: {}, state: 'running' })
    }
    const row = createElement(MobileNativeChatMessage, {
      message,
      mayStillGrow: working,
      activeTurnIsWorking: true
    })
    const revealing = createElement(
      MobileNativeChatReplyRevealsContext.Provider,
      { value: chat },
      row
    )
    const tree = createElement(
      MobileNativeChatGrowthHoldContext.Provider,
      { value: growth },
      revealing
    )
    act(() => {
      if (renderer) {
        renderer.update(tree)
      } else {
        renderer = create(tree)
      }
    })
  }
  function contents(): string[] {
    return renderer!.root
      .findAll((node) => String(node.type) === 'MobileMarkdown')
      .map((node) => String(node.props.content))
  }
  function drawn(): number {
    return contents().join('').length
  }
  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }
  function remount(text: string | string[]): void {
    act(() => renderer?.unmount())
    renderer = undefined
    render(text)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    vi.stubGlobal('requestAnimationFrame', (step: () => void) => setTimeout(step, 16))
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame))
    const tracker = createNativeChatReplyRevealTracker()
    trackNativeChatReplyRows(tracker, ['u1'], new Set(['u1']))
    const reveals = trackNativeChatReplyRows(tracker, ['u1', 'a1'], new Set(['u1', 'a1']))
    chat = { ...reveals, reducedMotion: false }
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    growth = createMobileNativeChatGrowthHold()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reveals each chunk over time, and a remounted row resumes instead of replaying', () => {
    render(first)
    expect(drawn()).toBe('word'.length)
    advance(DELAY / 2)
    expect(drawn()).toBeGreaterThan('word'.length)
    expect(drawn()).toBeLessThan(first.length)
    advance(DELAY)
    expect(drawn()).toBe(first.length)

    render(second)
    advance(DELAY / 2)
    const before = drawn()
    expect(before).toBeGreaterThan(first.length)
    expect(before).toBeLessThan(second.length)
    remount(second)
    expect(drawn()).toBeGreaterThanOrEqual(before)
    expect(drawn()).toBeLessThan(second.length)
    advance(DELAY)
    expect(drawn()).toBe(second.length)
  })

  it('waits while the page holds growth, then catches up in one step', () => {
    growth.set(true)
    render(first)
    const shown = drawn()
    advance(DELAY * 2)
    expect(drawn()).toBe(shown)
    act(() => growth.set(false))
    advance(16)
    expect(drawn()).toBe(first.length)
  })

  it.each([false, true])('paces a second prose block after the first caught up: %s', (caughtUp) => {
    render(first)
    advance(caughtUp ? DELAY : DELAY / 2)
    render([first, second])
    if (!caughtUp) {
      expect(contents()[0].length).toBeLessThan(first.length)
    }
    expect(contents()[1].length).toBeLessThan(second.length)
    advance(DELAY / 2)
    const before = drawn()
    expect(before).toBeGreaterThan(first.length)
    expect(before).toBeLessThan(first.length + second.length)
    remount([first, second])
    expect(drawn()).toBeGreaterThanOrEqual(before)
    expect(drawn()).toBeLessThan(first.length + second.length)
    advance(DELAY)
    expect(contents()).toEqual([first, second])
  })

  it('does not replay read text when a question ends while the row is unmounted', () => {
    render(first)
    advance(DELAY)
    render(first, false)
    expect(chat.drawn.has('a1')).toBe(false)
    act(() => renderer?.unmount())
    renderer = undefined
    render(first)
    expect(drawn()).toBe(first.length)
    render(second)
    expect(drawn()).toBeLessThan(second.length)
    advance(DELAY)
    expect(drawn()).toBe(second.length)
  })

  it('draws completed prose in full on first mount beside a running tool', () => {
    render(first, true, true)
    expect(contents()).toEqual([first])
    const tool = renderer!.root.find((node) => String(node.type) === 'ToolRun')
    expect(tool.props.blocks[0].state).toBe('running')
  })

  it('draws the text as it arrives with reduced motion', () => {
    chat = { ...chat, reducedMotion: true }
    render(second)
    expect(drawn()).toBe(second.length)
  })
})
