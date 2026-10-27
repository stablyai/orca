import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { buildMobileNativeChatTransientData } from '../../mobile-native-chat-render-data'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import { resetMobileNativeChatDraftStoreForTests } from './mobile-native-chat-draft-store'

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

function imageTurn(id: string, path: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: `[Image: source: ${path}]` }],
    timestamp,
    source: 'transcript'
  }
}

function renderedPendingTexts(
  messages: NativeChatMessage[],
  state: DraftState | null
): (string | undefined)[] {
  const { data } = buildMobileNativeChatTransientData({
    messages,
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
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness({
    messages,
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  }: {
    messages: NativeChatMessage[]
    transcriptLoading?: boolean
    transcriptSettled?: boolean
  }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab',
      sessionId: 'session',
      messages,
      transcriptLoading,
      transcriptSettled
    })
    return null
  }

  async function mount(
    messages: NativeChatMessage[],
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  ): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { messages, transcriptLoading, transcriptSettled }))
    })
  }

  async function update(
    messages: NativeChatMessage[],
    transcriptLoading = false,
    transcriptSettled = !transcriptLoading
  ): Promise<void> {
    await act(async () =>
      renderer?.update(createElement(Harness, { messages, transcriptLoading, transcriptSettled }))
    )
  }

  function send(text: string): void {
    const origin = state?.captureSendOrigin(text)
    if (origin) {
      state?.acceptSend(origin, text)
    }
  }

  function rapidSend(first: string, second: string): void {
    act(() => {
      send(first)
      send(second)
    })
  }

  const pendingTexts = (): (string | undefined)[] | undefined =>
    state?.pending.map((item) => item.text)

  it('retires both bubbles when the rapid sends land as one glued user row', async () => {
    const history = [assistantTurn('m1', 'ready', 1000)]
    await mount(history)
    rapidSend('run the tests', 'again')
    expect(pendingTexts()).toEqual(['run the tests', 'again'])

    const glued = [...history, userTurn('m2', 'run the tests again', 5000)]
    await update(glued)
    expect(state?.pending).toEqual([])
    expect(renderedPendingTexts(glued, state)).toEqual([])
  })

  it('keeps and renders both bubbles when the matching row predates the sends', async () => {
    const history = [
      userTurn('m1', 'run the tests again', 1000),
      assistantTurn('m2', 'done', 2000),
      assistantTurn('m3', 'anything else?', 3000)
    ]
    await mount(history)
    rapidSend('run the tests', 'again')

    await update([...history])
    expect(pendingTexts()).toEqual(['run the tests', 'again'])
    expect(renderedPendingTexts(history, state)).toEqual(['run the tests', 'again'])
  })

  // A resend must await its own row rather than reconcile against the earlier Stop-withdrawn message.
  it('keeps a resend bubble beside a stopped row of the same text until its own row lands', async () => {
    const history = [userTurn('m1', 'run the tests', 1000), assistantTurn('m2', 'stopped', 1100)]
    await mount(history)
    act(() => send('run the tests'))

    await update([...history])
    expect(pendingTexts()).toEqual(['run the tests'])

    const resent = [...history, userTurn('m3', 'run the tests', 5000)]
    await update(resent)
    expect(state?.pending).toEqual([])
    expect(renderedPendingTexts(resent, state)).toEqual([])
  })

  it('shows the text once at every step when the stopped row lands after the resend press', async () => {
    const history = [assistantTurn('m0', 'ready', 500)]
    await mount(history)
    act(() => send('run the tests'))
    expect(renderedPendingTexts(history, state)).toEqual(['run the tests'])

    const stopped = [...history, userTurn('m1', 'run the tests', 1000)]
    await update(stopped)
    expect(state?.pending).toEqual([])
    expect(renderedPendingTexts(stopped, state)).toEqual([])

    const resent = [...stopped, userTurn('m2', 'run the tests', 5000)]
    await update(resent)
    expect(state?.pending).toEqual([])
    expect(renderedPendingTexts(resent, state)).toEqual([])
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
    expect(pendingTexts()).toEqual(['again'])
    expect(renderedPendingTexts(partial, state)).toEqual(['again'])
  })

  // Rebase hydration-time sends on first authoritative history so they can retire without blocking later glue matches.
  describe('sends issued while the transcript is still hydrating', () => {
    const loadedHistory = [userTurn('m1', 'run the tests again', 1000)]

    it('keeps both bubbles when the loaded history only looks like their glue', async () => {
      await mount([], true)
      rapidSend('run the tests', 'again')

      await update(loadedHistory)
      expect(pendingTexts()).toEqual(['run the tests', 'again'])
      expect(renderedPendingTexts(loadedHistory, state)).toEqual(['run the tests', 'again'])
    })

    it('retires both bubbles once their glued row lands after hydration', async () => {
      await mount([], true)
      rapidSend('run the tests', 'again')
      await update(loadedHistory)

      const glued = [...loadedHistory, userTurn('m2', 'run the tests again', 5000)]
      await update(glued)
      expect(state?.pending).toEqual([])
      expect(renderedPendingTexts(glued, state)).toEqual([])
    })

    it('retires a hydration-time send on its own exact echo', async () => {
      await mount([], true)
      act(() => send('run the tests'))
      await update(loadedHistory)
      expect(pendingTexts()).toEqual(['run the tests'])

      const echoed = [...loadedHistory, userTurn('m2', 'run the tests', 5000)]
      await update(echoed)
      expect(state?.pending).toEqual([])
    })

    it('stops barring a later pair from gluing once its own echo lands', async () => {
      await mount([], true)
      act(() => send('hold this'))
      await update(loadedHistory)
      rapidSend('fix the', 'bug')

      const landed = [
        ...loadedHistory,
        userTurn('m2', 'hold this', 5000),
        userTurn('m3', 'fix the bug', 5100)
      ]
      await update(landed)
      expect(state?.pending).toEqual([])
    })

    // TUI sends lack ids/clock alignment to distinguish own echoes from identical old rows; claiming risks losing an undelivered repeat, while holding permanently blocks glue.
    it('retires a hydration-time send whose echo arrives with the read', async () => {
      await mount([], true)
      act(() => send('run the tests'))

      const echoed = [userTurn('m1', 'run the tests', 1000), assistantTurn('m2', 'passed', 1100)]
      await update(echoed)
      expect(state?.pending).toEqual([])
    })

    // Reconnect retains this session’s history; moving its send boundary onto the new read would exclude the send’s own glued row.
    it('retires a pair sent across a reconnect whose glued row arrives with the read', async () => {
      const retained = [userTurn('m1', 'earlier prompt', 1000), assistantTurn('m2', 'sure', 1100)]
      await mount(retained)
      await update(retained, true)
      rapidSend('run the tests', 'again')

      const settled = [...retained, userTurn('m3', 'run the tests again', 5000)]
      await update(settled)
      expect(state?.pending).toEqual([])
      expect(renderedPendingTexts(settled, state)).toEqual([])
    })

    // An image retires only by preview binding; excluding its own echo would strand both the photo and later glued sends.
    it('retires a photo whose image echo arrives with the read', async () => {
      await mount([], true)
      act(() => {
        const origin = state?.captureSendOrigin('')
        if (origin) {
          state?.acceptSend(origin, '', ['file:///new.png'])
        }
      })

      const withEcho = [assistantTurn('m1', 'ready', 1000), imageTurn('m2', '/tmp/new.png', 5000)]
      await update(withEcho)
      expect(state?.pending).toEqual([])
      expect(state?.imagePreviewsByMessageId).toEqual({ m2: ['file:///new.png'] })
    })

    it('leaves a later pair able to glue after the late read resolved the first send', async () => {
      await mount([], true)
      act(() => send('run the tests'))
      const afterReconnect = [userTurn('m1', 'run the tests', 5000)]
      await update(afterReconnect)
      expect(state?.pending).toEqual([])

      rapidSend('fix the', 'bug')
      const glued = [...afterReconnect, userTurn('m2', 'fix the bug', 6000)]
      await update(glued)
      expect(state?.pending).toEqual([])
      expect(renderedPendingTexts(glued, state)).toEqual([])
    })
  })

  // Failed-read emptiness is unknown history, not an empty conversation; old rows must not claim sends against it.
  describe('sends issued before any read settled', () => {
    it('keeps both bubbles when the late read carries only an older glue-alike', async () => {
      await mount([], false, false)
      rapidSend('fix the', 'bug')

      const olderIdentical = [
        userTurn('m1', 'fix the bug', 1000),
        assistantTurn('m2', 'fixed', 1100)
      ]
      await update(olderIdentical)
      expect(pendingTexts()).toEqual(['fix the', 'bug'])
      expect(renderedPendingTexts(olderIdentical, state)).toEqual(['fix the', 'bug'])
    })

    it('still retires them once their own glued row lands', async () => {
      await mount([], false, false)
      rapidSend('fix the', 'bug')
      const olderIdentical = [
        userTurn('m1', 'fix the bug', 1000),
        assistantTurn('m2', 'fixed', 1100)
      ]
      await update(olderIdentical)

      await update([...olderIdentical, userTurn('m3', 'fix the bug', 5000)])
      expect(state?.pending).toEqual([])
    })
  })
})
