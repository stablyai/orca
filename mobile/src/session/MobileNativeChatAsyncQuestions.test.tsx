import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileNativeChatPendingAsyncQuestions } from './MobileNativeChatPendingAsyncQuestions'
import { MobileNativeChatAsyncQuestions } from './MobileNativeChatAsyncQuestions'
import { MobileNativeChatAsyncQuestionProvider } from './MobileNativeChatAsyncQuestionProvider'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../src/shared/native-chat-question-auto-advance'
import type { NativeChatAsyncQuestion } from '../../../src/shared/native-chat-types'

vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  X: 'X'
}))

const questions = [{ title: 'Which branch?', options: ['main', 'release'] }]
const questionGroups = [questions]
const send = vi.fn<(text: string) => Promise<boolean>>()
let tree: ReactTestRenderer | undefined
/** Uses real cards and a shared reply provider to exercise competing answers. */
function Screen({
  disabled = false,
  groups = questionGroups
}: {
  disabled?: boolean
  groups?: NativeChatAsyncQuestion[][]
}) {
  return (
    <MobileNativeChatAsyncQuestionProvider reply={{ disabled: false, send }} disabled={disabled}>
      {groups.map((group, index) => (
        <MobileNativeChatAsyncQuestions key={index} questions={group} />
      ))}
    </MobileNativeChatAsyncQuestionProvider>
  )
}
function root() {
  if (!tree) {
    throw new Error('Card is not mounted')
  }
  return tree.root
}
/** Mounts the wizard and flushes React effects before interacting with it. */
async function mount(groups?: NativeChatAsyncQuestion[][]) {
  await act(async () => {
    tree = create(<Screen groups={groups} />)
  })
}
/** Selects an option without advancing its timer, so tests can change input ownership first. */
async function option(label: string) {
  await act(async () =>
    root()
      .find((node) => node.props.label === label)
      .props.onPress()
  )
}
function isHost(node: { type: unknown }, name: string): boolean {
  return node.type === name
}
/** Presses a mocked native control by its visible text, without a device or OS event. */
async function button(label: string) {
  const control = root().find(
    (node) =>
      isHost(node, 'Pressable') &&
      node.findAll((child) => isHost(child, 'Text') && child.props.children === label).length > 0
  )
  await act(async () => control.props.onPress())
}
function input() {
  return root().find((node) => isHost(node, 'TextInput'))
}
async function type(text: string) {
  await act(async () => input().props.onChangeText(text))
}
/** Completes the single-choice delay and flushes the resulting React updates. */
async function advance() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}
function strips() {
  return root().findAll(
    (node) => isHost(node, 'View') && node.props.testID === 'native-chat-prompt-strip'
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  send.mockReset().mockResolvedValue(true)
})
afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = undefined
  vi.useRealTimers()
})

it('sends grouped choices and Other text as one ordinary message', async () => {
  await mount([[...questions, { title: 'Anything else?', options: [] }]])
  await option('release')
  await advance()
  expect(send).not.toHaveBeenCalled()
  await option('Other…')
  await type('  Keep the docs  ')
  await button('Submit')
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Which branch?\nrelease\n\nAnything else?\nKeep the docs'
  )
  expect(strips()).toHaveLength(1)
})

it('folds without sending and keeps Other text when reopened', async () => {
  await mount()
  await option('Other…')
  await type('unfinished answer')
  await button('Cancel')
  expect(strips()).toHaveLength(1)
  expect(send).not.toHaveBeenCalled()
  await act(async () =>
    root()
      .find((node) => node.props.accessibilityLabel === 'Expand')
      .props.onPress()
  )
  expect(input().props.value).toBe('unfinished answer')
  await button('Submit')
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nunfinished answer')
})

it.each(['reject', 'throw'] as const)(
  'keeps the answer editable when delivery fails: %s',
  async (failure) => {
    if (failure === 'reject') {
      send.mockResolvedValueOnce(false)
    } else {
      send.mockRejectedValueOnce(new Error('Connection closed'))
    }
    await mount()
    await option('Other…')
    await type('keep this')
    await button('Submit')
    expect(strips()).toHaveLength(0)
    expect(input().props).toMatchObject({ value: 'keep this', editable: true })
    expect(send).toHaveBeenCalledTimes(1)
    await button('Submit')
    expect(send).toHaveBeenCalledTimes(2)
    expect(strips()).toHaveLength(1)
  }
)

it('blocks every card while a reply awaits acknowledgement, including an earlier timer', async () => {
  const delivery = Promise.withResolvers<boolean>()
  send.mockReturnValueOnce(delivery.promise)
  await mount([questions, [{ title: 'Run checks?', options: ['yes', 'no'] }]])
  await option('release')
  await option('yes')
  await advance()
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nrelease')
  expect(
    root()
      .findAllByType(MobileNativeChatAsk)
      .every((card) => card.props.disabled)
  ).toBe(true)
  expect(strips()).toHaveLength(0)
  await act(async () => delivery.resolve(true))
  expect(strips()).toHaveLength(1)
  expect(root().findAllByType(MobileNativeChatAsk)[1]?.props.disabled).toBe(false)
})

it('prevents a scheduled reply when another prompt takes the input', async () => {
  await mount()
  await option('release')
  await act(async () => tree?.update(<Screen disabled />))
  await advance()
  expect(send).not.toHaveBeenCalled()
  await act(async () => tree?.update(<Screen />))
  await button('Submit')
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nrelease')
})

it('does not submit an empty Other answer', async () => {
  await mount()
  await option('Other…')
  await type('   ')
  await button('Submit')
  await advance()
  expect(send).not.toHaveBeenCalled()
})

it('shows questions outside the transcript and follows the host resolution without losing a draft on output', async () => {
  function HostScreen({ resolved = false }: { resolved?: boolean }) {
    return (
      <MobileNativeChatAsyncQuestionProvider
        reply={{ disabled: false, send }}
        disabled={false}
        pendingQuestions={resolved ? [] : [{ key: 'old-ask', questions }]}
      >
        <MobileNativeChatPendingAsyncQuestions />
      </MobileNativeChatAsyncQuestionProvider>
    )
  }
  await act(async () => {
    tree = create(<HostScreen />)
  })
  await option('Other…')
  await type('keep this draft')
  await act(async () => tree?.update(<HostScreen />))
  expect(input().props.value).toBe('keep this draft')
  await act(async () => tree?.update(<HostScreen resolved />))
  expect(root().findAllByType(MobileNativeChatAsk)).toHaveLength(0)
})
