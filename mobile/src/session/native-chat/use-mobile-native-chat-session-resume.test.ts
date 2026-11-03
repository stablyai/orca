import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { RpcClient } from '../../transport/rpc-client'
import { mobileNativeChatTranscriptCache } from './mobile-native-chat-transcript-cache'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'

function row(id: string, transcriptOrder?: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript',
    ...(transcriptOrder === undefined ? {} : { transcriptOrder })
  }
}

describe('useMobileNativeChatSession reopening a cached chat', () => {
  let renderer: ReactTestRenderer | null = null
  let renders: {
    status: string
    ids: string[]
    hasMore: boolean
    transcriptLoading: boolean
  }[] = []
  let frames: ((frame: unknown) => void)[] = []
  const subscribe = vi.fn(
    (_method: string, _params: Record<string, unknown>, onData: (f: unknown) => void) => {
      frames.push(onData)
      return () => {}
    }
  )
  const client = { subscribe } as unknown as RpcClient

  beforeEach(() => {
    mobileNativeChatTranscriptCache.clear()
    renders = []
    frames = []
    subscribe.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({ sessionId }: { sessionId: string }): null {
    const session = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host\0workspace',
      agent: 'claude',
      sessionId,
      transcriptPath: null
    })
    renders.push({
      status: session.status,
      ids: session.messages.map(({ id }) => id),
      hasMore: session.hasMore,
      transcriptLoading: session.transcriptLoading
    })
    return null
  }

  async function visitThenLeave(firstFrame: unknown): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { sessionId: 'a' }))
    })
    await act(async () => frames.at(-1)?.(firstFrame))
    await act(async () => renderer?.update(createElement(Harness, { sessionId: 'b' })))
    renders = []
  }

  const reopen = (): Promise<void> =>
    act(async () => renderer?.update(createElement(Harness, { sessionId: 'a' })))

  const lastSubscribeParams = (): Record<string, unknown> | undefined =>
    subscribe.mock.lastCall?.[1]

  it('shows the cached rows on the first render and merges a page starting at the held row', async () => {
    await visitThenLeave({
      type: 'snapshot',
      messages: [row('m1', 100), row('m2', 200)],
      hasMore: true,
      beforeOffset: 100
    })
    await reopen()

    expect(renders[0]).toMatchObject({ status: 'loading', ids: ['m1', 'm2'] })
    expect(lastSubscribeParams()).toMatchObject({
      limit: 40,
      resumeAfter: { id: 'm2', transcriptOrder: 200, timestamp: 1 }
    })

    await act(async () =>
      frames.at(-1)?.({
        type: 'snapshot',
        resumed: true,
        messages: [row('m2', 200), row('m3', 300)],
        hasMore: true,
        beforeOffset: 200
      })
    )
    expect(renders.at(-1)).toMatchObject({
      status: 'ready',
      ids: ['m1', 'm2', 'm3'],
      hasMore: true
    })
  })

  it('replaces the cached rows when the host answers with any other first page', async () => {
    await visitThenLeave({
      type: 'snapshot',
      messages: [row('m1', 100), row('m2', 200)],
      hasMore: false,
      beforeOffset: 100
    })
    await reopen()
    // Starts at the held id but isn't resumed: the host found that row somewhere else in the file.
    await act(async () =>
      frames.at(-1)?.({
        type: 'snapshot',
        messages: [row('m2', 50), row('x1', 60)],
        hasMore: false
      })
    )

    expect(renders.at(-1)).toMatchObject({ status: 'ready', ids: ['m2', 'x1'] })
  })

  it('unsettles on a pending frame but keeps the rows the resumed page continues', async () => {
    await visitThenLeave({
      type: 'snapshot',
      messages: [row('m1', 100), row('m2', 200)],
      hasMore: false,
      beforeOffset: 100
    })
    await reopen()
    await act(async () =>
      frames.at(-1)?.({ type: 'snapshot', messages: [], hasMore: false, pending: true })
    )
    expect(renders.at(-1)).toMatchObject({ status: 'awaiting-transcript', ids: ['m1', 'm2'] })

    await act(async () =>
      frames.at(-1)?.({
        type: 'snapshot',
        resumed: true,
        messages: [row('m2', 200)],
        hasMore: true,
        beforeOffset: 200
      })
    )

    expect(renders.at(-1)).toMatchObject({ status: 'ready', ids: ['m1', 'm2'] })
  })

  it('keeps cached rows unconfirmed when the reopen fails before any read', async () => {
    await visitThenLeave({
      type: 'snapshot',
      messages: [row('m1', 100)],
      hasMore: false,
      beforeOffset: 100
    })
    await reopen()
    await act(async () => frames.at(-1)?.({ type: 'error', message: 'Transcript unavailable' }))

    expect(renders.at(-1)).toMatchObject({
      status: 'error',
      ids: ['m1'],
      transcriptLoading: true
    })
  })

  it('shows rows from a host without file offsets but asks it for a normal snapshot', async () => {
    await visitThenLeave({ type: 'snapshot', messages: [row('m1')], hasMore: false })
    await reopen()

    expect(renders[0]).toMatchObject({ status: 'loading', ids: ['m1'] })
    expect(lastSubscribeParams()).not.toHaveProperty('resumeAfter')
  })
})
