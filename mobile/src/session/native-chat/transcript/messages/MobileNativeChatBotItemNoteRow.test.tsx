import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { BotItemNoteView } from '../../../../../../src/shared/bots/bot-item-note'
import { BotChatOpenContext, BotItemOpenContext } from '../../../../bots/bot-item-open'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ListTodo: 'ListTodo', MessageSquare: 'MessageSquare' }))
vi.mock('../../../../bots/items/MobileBotItemStatusIcon', () => ({
  MobileBotItemStatusIcon: 'MobileBotItemStatusIcon'
}))
vi.mock('../message-content/MobileNativeChatProse', () => ({ Prose: 'Prose' }))

import { MobileNativeChatBotItemNoteRow } from './MobileNativeChatBotItemNoteRow'

const note: BotItemNoteView = {
  noteId: 'n1',
  by: 'bot',
  entries: [
    { uid: 'a', number: 1, title: 'Share dialog', status: 'needs_you', event: 'made' },
    { uid: 'b', number: 2, title: 'Release notes', status: 'planned', event: 'made' }
  ]
}

function chipLabels(open: ((uid: string) => void) | null): unknown[] {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(
        BotItemOpenContext.Provider,
        { value: open },
        createElement(MobileNativeChatBotItemNoteRow, { note, rowId: 'r', fontScale: 1 })
      )
    )
  })
  return renderer!.root
    .findAll((node) => node.props.accessibilityLabel !== undefined)
    .map((node): unknown => node.props.accessibilityLabel)
}

// A chip's status shows only as a glyph, so a screen reader hears it in the chip's label.
describe('item chips', () => {
  it('say each item status, whether or not they open', () => {
    const labels = ['Share dialog, Needs you', 'Release notes, Planned']
    expect(chipLabels(null)).toEqual(labels)
    expect(chipLabels(() => {})).toEqual(labels)
  })
})

describe('owner comments', () => {
  it('drop the [Image #N] their send wrote for their images, and keep any past that count', () => {
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(MobileNativeChatBotItemNoteRow, {
          note: {
            noteId: 'n2',
            by: 'owner',
            entries: [
              {
                uid: 'a',
                number: 1,
                title: 'Share dialog',
                status: 'working',
                event: 'commented',
                text: 'Clipped [Image #1] here, not [Image #2]',
                images: [{ path: '/store/a.png', name: 'a.png', bytes: 1 }]
              }
            ]
          },
          rowId: 'r',
          fontScale: 1
        })
      )
    })
    expect(renderer!.root.find((node) => String(node.type) === 'Prose').props.text).toBe(
      'Clipped  here, not [Image #2]'
    )
  })
})

describe("another chat's write", () => {
  it('names that chat as a chip that opens it, before the item', () => {
    const opened: unknown[] = []
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(
        createElement(
          BotChatOpenContext.Provider,
          { value: (chat: { chatId: string; home?: true }) => opened.push(chat) },
          createElement(MobileNativeChatBotItemNoteRow, {
            note: {
              noteId: 'm1',
              by: { kind: 'chat', chatId: 'chat-a', title: 'Debug Slack replies' },
              entries: [
                {
                  uid: 'a',
                  number: 90,
                  title: 'Status brief',
                  status: 'done',
                  event: 'status',
                  from: 'working',
                  to: 'done'
                }
              ]
            },
            rowId: 'r',
            fontScale: 1
          })
        )
      )
    })
    const root = renderer!.root
    const texts: unknown[] = root
      .findAll((node) => String(node.type) === 'Text')
      .map((node): unknown => node.props.children)
    expect(texts).toEqual(['Debug Slack replies', 'marked', 'Status brief', 'done'])
    act(() => {
      root
        .find((node) => node.props.accessibilityLabel === 'Open Debug Slack replies')
        .props.onPress()
    })
    expect(opened).toEqual([expect.objectContaining({ chatId: 'chat-a' })])
  })
})
