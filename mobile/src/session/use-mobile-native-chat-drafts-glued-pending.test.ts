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

function imageTurn(id: string, path: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: `[Image: source: ${path}]` }],
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

  /** Two composer sends fired before either transcript echo lands. */
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
    expect(pendingTexts()).toEqual(['run the tests', 'again'])
    expect(renderedPendingTexts(history, state)).toEqual(['run the tests', 'again'])
  })

  // FP2: an older turn reads like the concatenation of two much later sends.
  it('keeps and renders both bubbles when an older turn spells them out', async () => {
    const history = [userTurn('m1', 'fix the bug', 1000), assistantTurn('m2', 'fixed', 1100)]
    await mount(history)
    rapidSend('fix the', 'bug')

    await update([...history])
    expect(pendingTexts()).toEqual(['fix the', 'bug'])
    expect(renderedPendingTexts(history, state)).toEqual(['fix the', 'bug'])
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

  // STA-4492 / #14819: sends issued mid-hydration used to be marked permanently
  // untrusted, so their glued row could never retire them and they also barred
  // their neighbours from matching. The first authoritative read rebases them
  // instead: history that arrives with it is still not theirs, but everything
  // after it is.
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

    // The read that resolves a hydration-time send can already contain that
    // send's own echo — a re-subscribe returns whatever exists now — and nothing
    // local tells that echo from an identical older prompt. Claiming the row is
    // the lesser evil, not a free one: normally the real echo lands a round trip
    // later, but a send that never landed and was claimed by an older identical
    // row stops being tracked at all — worst for short repeats ("yes", "1").
    // Holding instead costs a queued bubble that never clears AND a run that can
    // never glue again, for the rest of the session.
    it('retires a hydration-time send whose echo arrives with the read', async () => {
      await mount([], true)
      act(() => send('run the tests'))

      const echoed = [userTurn('m1', 'run the tests', 1000), assistantTurn('m2', 'passed', 1100)]
      await update(echoed)
      expect(state?.pending).toEqual([])
    })

    // The same read seen one reconnect later: the send left, the agent echoed it,
    // and only then did the first authoritative read land.
    it('retires a hydration-time send after a reconnect delivered the read late', async () => {
      await mount([], true)
      act(() => send('run the tests'))
      // Still loading: the first read never arrived before the drop.
      await update([], true)

      const afterReconnect = [
        userTurn('m1', 'run the tests', 5000),
        assistantTurn('m2', 'ok', 5100)
      ]
      await update(afterReconnect)
      expect(state?.pending).toEqual([])

      // Nothing later resurrects it, and the run stays glue-capable.
      await update([...afterReconnect, assistantTurn('m3', 'all green', 6000)])
      expect(state?.pending).toEqual([])
    })

    // A reconnect leaves this session's own retained history on screen, so sends
    // made across it own a real boundary already. Moving it onto the read that
    // follows would push it past their own glued row and strand both bubbles.
    it('retires a pair sent across a reconnect whose glued row arrives with the read', async () => {
      const retained = [userTurn('m1', 'earlier prompt', 1000), assistantTurn('m2', 'sure', 1100)]
      await mount(retained)
      // The read drops; the retained history stays visible and is still ours.
      await update(retained, true)
      rapidSend('run the tests', 'again')

      const settled = [...retained, userTurn('m3', 'run the tests again', 5000)]
      await update(settled)
      expect(state?.pending).toEqual([])
      expect(renderedPendingTexts(settled, state)).toEqual([])
    })

    // A send held here would sit as a live segment at the head of its run, so
    // the cursor could never reach a later pair — the stuck bubble would take
    // the whole feature down with it for the rest of the session.
    // An image entry retires ONLY by binding its preview, so a supplied tail
    // that excluded its own echo would leave the bubble — and the photo — stuck
    // for the life of the session.
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

  // A read that failed is not a boundary: `messages` is empty because the history
  // is unknown, not because the conversation is. Without that distinction the
  // empty list reads as "the transcript was empty", and any row the successful
  // read finally brings can claim these sends.
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
