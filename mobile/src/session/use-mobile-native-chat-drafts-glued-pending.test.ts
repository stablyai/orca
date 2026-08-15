import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { buildMobileNativeChatTransientData } from './mobile-native-chat-render-data'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>
type TestRenderer = {
  unmount(): void
  update(element: ReturnType<typeof createElement>): void
}

function userTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

/** Texts of the optimistic bubbles the chat list actually renders. */
function renderedPendingTexts(
  messages: NativeChatMessage[],
  state: DraftState | null
): (string | undefined)[] {
  const { data } = buildMobileNativeChatTransientData({
    folded: messages,
    streaming: null,
    pending: state?.pending ?? []
  })
  return data
    .filter((message) => !messages.some((existing) => existing.id === message.id))
    .map((message) => message.blocks.find((block) => block.type === 'text')?.text)
}

describe('useMobileNativeChatDrafts glued pending sends', () => {
  let renderer: TestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({
    messages,
    transcriptLoading = false
  }: {
    messages: NativeChatMessage[]
    transcriptLoading?: boolean
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId: 'session',
      messages,
      transcriptLoading
    })
    return null
  }

  async function mount(messages: NativeChatMessage[], transcriptLoading = false): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { messages, transcriptLoading }))
    })
  }

  async function update(messages: NativeChatMessage[], transcriptLoading = false): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { messages, transcriptLoading })))
  }

  /** Two composer sends fired before either transcript echo lands. */
  function rapidSend(first: string, second: string): void {
    act(() => {
      const originFirst = state?.captureSendOrigin(first)
      if (originFirst) {
        state?.acceptSend(originFirst, first)
      }
      const originSecond = state?.captureSendOrigin(second)
      if (originSecond) {
        state?.acceptSend(originSecond, second)
      }
    })
  }

  it('retires both bubbles when the rapid sends land as one glued user row', async () => {
    const history = [assistantTurn('m1', 'ready', 1000)]
    await mount(history)
    rapidSend('run the tests', 'again')
    expect(state?.pending.map((item) => item.text)).toEqual(['run the tests', 'again'])

    const glued = [...history, userTurn('m2', 'run the tests again', 5000)]
    await update(glued)
    expect(state?.pending).toEqual([])
    expect(renderedPendingTexts(glued, state)).toEqual([])
  })

  // FP1: the concatenation already sits in history, older than the sends.
  it('keeps and renders both bubbles when the matching row predates the sends', async () => {
    const history = [
      userTurn('m1', 'run the tests again', 1000),
      assistantTurn('m2', 'done', 2000),
      assistantTurn('m3', 'anything else?', 3000)
    ]
    await mount(history)
    rapidSend('run the tests', 'again')

    await update([...history])
    expect(state?.pending.map((item) => item.text)).toEqual(['run the tests', 'again'])
    expect(renderedPendingTexts(history, state)).toEqual(['run the tests', 'again'])
  })

  // FP2: an older turn reads like the concatenation of two much later sends.
  it('keeps and renders both bubbles when an older turn spells them out', async () => {
    const history = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    await mount(history)
    rapidSend('fix the', 'bug')

    await update([...history])
    expect(state?.pending.map((item) => item.text)).toEqual(['fix the', 'bug'])
    expect(renderedPendingTexts(history, state)).toEqual(['fix the', 'bug'])
  })

  it('keeps both bubbles when history loads after their baseline was captured', async () => {
    await mount([], true)
    rapidSend('run the tests', 'again')

    const loadedHistory = [userTurn('m1', 'run the tests again', 1000)]
    await update(loadedHistory)
    expect(state?.pending.map((item) => item.text)).toEqual(['run the tests', 'again'])
    expect(renderedPendingTexts(loadedHistory, state)).toEqual(['run the tests', 'again'])
  })

  it('still retires each bubble on its own when the sends do not glue', async () => {
    const history = [assistantTurn('m1', 'ready', 1000)]
    await mount(history)
    rapidSend('run the tests', 'again')

    const separate = [
      ...history,
      userTurn('m2', 'run the tests', 5000),
      userTurn('m3', 'again', 5100)
    ]
    await update(separate)
    expect(state?.pending).toEqual([])
  })

  it('keeps the second bubble when only the first send has echoed', async () => {
    const history = [assistantTurn('m1', 'ready', 1000)]
    await mount(history)
    rapidSend('run the tests', 'again')

    const partial = [...history, userTurn('m2', 'run the tests', 5000)]
    await update(partial)
    expect(state?.pending.map((item) => item.text)).toEqual(['again'])
    expect(renderedPendingTexts(partial, state)).toEqual(['again'])
  })
})
