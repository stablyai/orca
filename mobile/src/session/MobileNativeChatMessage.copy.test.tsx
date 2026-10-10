import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'

const { writeText, alert } = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
  alert: vi.fn()
}))
vi.mock('react-native', () => ({
  Alert: { alert },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', Check: 'Check' }))
vi.mock('../components/MobileSelectableText', () => ({ MobileSelectableText: 'Text' }))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('./MobileNativeChatReasoningRow', () => ({ MobileNativeChatReasoningRow: 'Reasoning' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'TurnStatus' }))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatLongPressContent } from './MobileNativeChatLongPressContent'

const first = '# Answer\n\n- first\n  - nested\n\n```ts\n  const x = 1\n```'
const last = '| Name | Value |\n| --- | --- |\n| x | 1 |\n\nFinal paragraph.\n'
const message: NativeChatMessage = {
  id: 'reply',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Started' }]
}

function pendingWrite() {
  let settle: (outcome: 'success' | 'failure') => void = () => {
    throw new Error('Clipboard write is not pending')
  }
  const promise = new Promise<void>((resolve, reject) => {
    settle = (outcome) => {
      if (outcome === 'success') {
        resolve()
      } else {
        reject(new Error('Unavailable'))
      }
    }
  })
  return { promise, finish: (outcome: 'success' | 'failure') => settle(outcome) }
}

describe('iOS whole-message copy', () => {
  let renderer: ReactTestRenderer | undefined
  const nodes = (type: string) => renderer!.root.findAll((node) => String(node.type) === type)
  function copyButton() {
    const node = nodes('Pressable').find(
      (button) => button.props.accessibilityLabel === 'Copy message'
    )
    if (!node) {
      throw new Error('Copy message action is missing')
    }
    return node
  }
  function render(value = message) {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message: value }))
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    writeText.mockResolvedValue(undefined)
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  })

  it.each(['user', 'assistant'] as const)(
    'copies current %s source outside the text after streaming',
    async (role) => {
      render({ ...message, role })
      const current: NativeChatMessage = {
        ...message,
        role,
        blocks: [
          { type: 'text', text: first },
          { type: 'tool-call', name: 'Read', input: { file_path: 'private.txt' } },
          { type: 'image-ref', path: '/attachment.png' },
          { type: 'text', text: last }
        ]
      }
      act(() => renderer!.update(createElement(MobileNativeChatMessage, { message: current })))
      const copy = copyButton()
      expect(copy.props.accessibilityRole).toBe('button')
      expect(copy.props.style({ pressed: false })[0]).toMatchObject({ width: 24, height: 24 })
      expect(copy.findAll((node) => String(node.type) === 'Text')).toHaveLength(0)
      expect(nodes('Copy')[0]?.props).toMatchObject({ size: 14, color: colors.textMuted })
      expect(copy.props.onLongPress).toBeUndefined()
      const body = renderer!.root.findByType(MobileNativeChatLongPressContent)
      expect(body.findAll((node) => node.props.accessibilityLabel === 'Copy message')).toHaveLength(
        0
      )
      expect(
        copy.findAll((node) => ['MobileMarkdown', 'ToolRun'].includes(String(node.type)))
      ).toHaveLength(0)
      for (const node of nodes('MobileMarkdown')) {
        expect(node.props.onLongPress).toBeUndefined()
      }
      expect(nodes('Pressable').filter((node) => node.props.onLongPress)).toHaveLength(0)
      await act(async () => copy.props.onPress())
      expect(writeText.mock.calls).toEqual([[first + '\n\n' + last]])
      expect(nodes('MessageActionsSheet')).toHaveLength(0)
      expect(nodes('Check')).toHaveLength(1)
      expect(nodes('Check')[0]?.props).toMatchObject({ size: 14, color: colors.statusGreen })
      expect(copyButton().props.accessibilityValue).toEqual({ text: 'Copied' })
      expect(copyButton().props.style({ pressed: false })[0]).toMatchObject({
        width: 24,
        height: 24
      })
      expect(copyButton().findAll((node) => String(node.type) === 'Text')).toHaveLength(0)
    }
  )

  it.each([
    'Please repair this chart:\n::orca-visual{file="usage.html"}\nKeep this text.',
    '::orca-visual{file="usage.html"}'
  ])('copies the entire visible own source %j', async (text) => {
    render({ ...message, role: 'user', blocks: [{ type: 'text', text }] })
    expect(nodes('Text').some((node) => node.props.children === text)).toBe(true)
    expect(copyButton().props.accessibilityRole).toBe('button')
    await act(async () => copyButton().props.onPress())
    expect(writeText.mock.calls).toEqual([[text]])
    expect(nodes('Check')).toHaveLength(1)
  })

  it('omits assistant visual directives while retaining literal fenced code', async () => {
    const text =
      'Chart:\n::orca-visual{file="usage.html"}\nDone.\n```text\n::orca-visual{file="example.html"}\n```'
    render({ ...message, blocks: [{ type: 'text', text }] })
    await act(async () => copyButton().props.onPress())
    expect(writeText.mock.calls).toEqual([
      ['Chart:\nDone.\n```text\n::orca-visual{file="example.html"}\n```']
    ])
    expect(nodes('Check')).toHaveLength(1)
  })

  it('reports clipboard rejection without claiming Copied', async () => {
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    render()
    await act(async () => copyButton().props.onPress())
    expect(alert).toHaveBeenCalledWith('Copy failed', 'Clipboard unavailable')
    expect(nodes('Check')).toHaveLength(0)
    expect(nodes('Text').some((node) => node.props.children === 'Copied')).toBe(false)
  })

  it('clears success when source changes and never creates idle-row timers', async () => {
    vi.useFakeTimers()
    render()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    act(() =>
      renderer!.update(
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'text', text: 'New source' }] }
        })
      )
    )
    expect(nodes('Check')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    act(() => renderer!.update(createElement(MobileNativeChatMessage, { message })))
    expect(nodes('Check')).toHaveLength(0)
    await act(async () => copyButton().props.onPress())
    act(() => renderer!.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'drops late %s feedback after unmount',
    async (outcome) => {
      vi.useFakeTimers()
      let finish = () => {}
      writeText.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finish = outcome === 'success' ? resolve : () => reject(new Error('Unavailable'))
        })
      )
      render()
      act(() => copyButton().props.onPress())
      act(() => renderer!.unmount())
      await act(async () => finish())
      expect(alert).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['success', 'failure'] as const)(
    'suppresses stale success but reports %s after source changes',
    async (outcome) => {
      vi.useFakeTimers()
      let finish = () => {}
      writeText.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finish = outcome === 'success' ? resolve : () => reject(new Error('Unavailable'))
        })
      )
      render()
      act(() => copyButton().props.onPress())
      act(() =>
        renderer!.update(
          createElement(MobileNativeChatMessage, {
            message: { ...message, blocks: [{ type: 'text', text: 'Newest source' }] }
          })
        )
      )
      await act(async () => finish())
      expect(writeText.mock.calls).toEqual([['Started']])
      expect(nodes('Check')).toHaveLength(0)
      if (outcome === 'failure') {
        expect(alert).toHaveBeenCalledExactlyOnceWith('Copy failed', 'Unavailable')
      } else {
        expect(alert).not.toHaveBeenCalled()
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('expires confirmation so later copies are still available', async () => {
    vi.useFakeTimers()
    render()
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(nodes('Check')).toHaveLength(0)
    await act(async () => copyButton().props.onPress())
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('keeps pending success stale when the original source returns', async () => {
    vi.useFakeTimers()
    const pending = pendingWrite()
    writeText.mockReturnValueOnce(pending.promise)
    render()
    act(() => copyButton().props.onPress())
    act(() =>
      renderer!.update(
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'text', text: 'Changed source' }] }
        })
      )
    )
    act(() => renderer!.update(createElement(MobileNativeChatMessage, { message })))
    await act(async () => pending.finish('success'))
    expect(nodes('Check')).toHaveLength(0)
    expect(alert).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'ignores an older overlapping %s while the newest write is pending',
    async (outcome) => {
      vi.useFakeTimers()
      const older = pendingWrite(),
        newest = pendingWrite()
      writeText.mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise)
      render()
      act(() => copyButton().props.onPress())
      act(() => copyButton().props.onPress())
      await act(async () => older.finish(outcome))
      expect(nodes('Check')).toHaveLength(0)
      expect(alert).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await act(async () => newest.finish('failure'))
      expect(alert).toHaveBeenCalledExactlyOnceWith('Copy failed', 'Unavailable')
      expect(nodes('Check')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([
    ['success', 'success'],
    ['success', 'failure'],
    ['failure', 'success'],
    ['failure', 'failure']
  ] as const)(
    'ignores repeated older %s results after the newest %s',
    async (olderOutcome, newestOutcome) => {
      vi.useFakeTimers()
      const older = pendingWrite(),
        middle = pendingWrite(),
        newest = pendingWrite()
      writeText
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(middle.promise)
        .mockReturnValueOnce(newest.promise)
      render()
      for (const text of ['Started', 'Middle source', 'Newest source']) {
        act(() =>
          renderer!.update(
            createElement(MobileNativeChatMessage, {
              message: { ...message, blocks: [{ type: 'text', text }] }
            })
          )
        )
        act(() => copyButton().props.onPress())
      }
      await act(async () => newest.finish(newestOutcome))
      await act(async () => middle.finish(olderOutcome))
      await act(async () => older.finish(olderOutcome))
      expect(writeText.mock.calls).toEqual([['Started'], ['Middle source'], ['Newest source']])
      expect(nodes('Check')).toHaveLength(newestOutcome === 'success' ? 1 : 0)
      if (newestOutcome === 'failure') {
        expect(alert).toHaveBeenCalledExactlyOnceWith('Copy failed', 'Unavailable')
        expect(vi.getTimerCount()).toBe(0)
      } else {
        expect(alert).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)
        act(() => {
          vi.advanceTimersByTime(1499)
        })
        expect(nodes('Check')).toHaveLength(1)
        act(() => {
          vi.advanceTimersByTime(1)
        })
        expect(nodes('Check')).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  )

  it('clears an earlier success when the next copy is rejected', async () => {
    vi.useFakeTimers()
    render()
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(0)
    expect(alert).toHaveBeenCalledWith('Copy failed', 'Clipboard unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has no copy footer for image-only or tool-only messages', () => {
    render({ ...message, blocks: [{ type: 'image-ref', path: '/attachment.png' }] })
    expect(nodes('Pressable')).toHaveLength(0)
    act(() =>
      renderer!.update(
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'tool-call', name: 'Read', input: {} }] }
        })
      )
    )
    expect(nodes('Pressable')).toHaveLength(0)
  })
})
