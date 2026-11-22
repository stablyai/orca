import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const { reactNativeMotionStub } = await import('../../test-support/react-native-motion-stub')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ...reactNativeMotionStub(),
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) },
    useColorScheme: () => 'dark',
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      flatten: (s: unknown) => s
    }
  }
})
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  CircleHelp: 'CircleHelp',
  Shield: 'Shield'
}))
vi.mock('../../platform/haptics/haptics', () => ({ triggerSelection: vi.fn() }))
const save = vi.hoisted(() => vi.fn<(itemId: string) => Promise<unknown>>())
vi.mock('../../session/native-chat/agent-session/use-mobile-structured-async-questions', () => ({
  useMobileStructuredAsyncQuestions: (chat: { sessionId: string | null }) => ({
    asyncQuestionSourceScope: 'scope',
    asyncQuestionSkip:
      chat.sessionId === 'chat-1'
        ? {
            skippedThrough: undefined,
            awaiting: { itemId: 'ask-row', text: 'File the follow-up?' },
            save
          }
        : null
  })
}))

import type { BotChatTreeChat } from '../../../../src/shared/bots/bot-chat-tree'
import { MobileBotNeedsYouGroup } from './MobileBotNeedsYouGroup'
import type { PhoneAsk } from './phone-needs-you-asks'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row passes the chat back to its opener only.
const chat = { chatId: 'chat-1' } as BotChatTreeChat
const ask: PhoneAsk = {
  key: 'chat:chat-1',
  approval: false,
  title: 'Review',
  worker: null,
  number: null,
  tool: null,
  open: { chat }
}

it('says the question a chat waits on and Skips it by its row, telling a failed Skip', async () => {
  const failed = vi.fn()
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(MobileBotNeedsYouGroup, {
        botName: 'Reviewer',
        asks: [ask],
        items: [],
        disabled: false,
        renderItem: () => null,
        onOpenAsk: () => {},
        client: null,
        onSkipFailed: failed
      })
    )
  })
  const texts = renderer!.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.props.children)
  expect(texts).toContain('File the follow-up?')
  expect(texts).not.toContain('Waiting for you')
  const skip = renderer!.root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Skip: Review'
  )

  save.mockResolvedValueOnce(undefined)
  await act(async () => skip.props.onPress())
  expect(save).toHaveBeenCalledWith('ask-row')
  expect(failed).not.toHaveBeenCalled()

  save.mockRejectedValueOnce(new Error('offline'))
  await act(async () => skip.props.onPress())
  expect(failed).toHaveBeenCalledWith('Something went wrong. Try again.')
})
