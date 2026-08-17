// Outcome-level guard for STA-4363 on mobile: what the chat list ends up
// showing after a send whose text is nothing but `[Image #n]` markers, and what
// an incomplete multi-image echo is allowed to do to the local previews.

import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

function userTextMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('mobile literal image-marker turns', () => {
  let updateRenderer: (messages: NativeChatMessage[]) => void = () => {}
  let unmountRenderer = (): void => {}
  let state: DraftState | null = null

  afterEach(() => {
    act(unmountRenderer)
    updateRenderer = () => {}
    unmountRenderer = () => {}
    state = null
  })

  function Harness({ messages = [] }: { messages?: NativeChatMessage[] }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'a',
      sessionId: 'session-a',
      messages,
      // These cases all model a settled read: the sends below own real
      // boundaries, so retirement may judge transcript rows against them.
      transcriptSettled: true
    })
    return null
  }

  async function mount(): Promise<void> {
    await act(async () => {
      const renderer = create(createElement(Harness, {}))
      updateRenderer = (messages) => renderer.update(createElement(Harness, { messages }))
      unmountRenderer = () => renderer.unmount()
    })
  }

  async function transcript(messages: NativeChatMessage[]): Promise<void> {
    await act(async () => updateRenderer(messages))
  }

  function send(text: string, images?: string[]): void {
    const origin = state?.captureSendOrigin(text, images)
    act(() => {
      if (origin) {
        state?.acceptSend(origin, text, images)
      }
    })
  }

  /** The rows the chat list renders: folded transcript (with any rebound local
   *  previews) followed by the still-unreconciled optimistic echoes. */
  function rows(messages: NativeChatMessage[]): NativeChatMessage[] {
    return buildMobileNativeChatTransientData({
      folded: foldMobileNativeChatMessages(messages),
      streaming: null,
      pending: state?.pending ?? [],
      imagePreviewsByMessageId: state?.imagePreviewsByMessageId
    }).data
  }

  function rowText(message: NativeChatMessage): string {
    return message.blocks
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('')
  }

  function rowImages(message: NativeChatMessage): string[] {
    return message.blocks
      .filter(isImageRefBlock)
      .map((block) => block.url ?? block.path ?? '')
      .filter(Boolean)
  }

  it('shows a standalone marker-only send exactly once', async () => {
    await mount()
    send('[Image #1]')

    const messages = [userTextMessage('u1', '[Image #1]')]
    await transcript(messages)

    expect(rows(messages).map(rowText)).toEqual(['[Image #1]'])
  })

  it('shows a marker-only send with surrounding prose exactly once', async () => {
    await mount()
    send('keep [Image #1] literal')

    const messages = [userTextMessage('u1', 'keep [Image #1] literal')]
    await transcript(messages)

    expect(rows(messages).map(rowText)).toEqual(['keep [Image #1] literal'])
  })

  it('does not let a markerless row retire marker-bearing literal text', async () => {
    await mount()
    send('keep [Image #1] literal')

    const markerless = [userTextMessage('wrong', 'keep literal')]
    await transcript(markerless)
    expect(rows(markerless).map(rowText)).toEqual(['keep literal', 'keep [Image #1] literal'])

    const exact = [userTextMessage('right', 'keep [Image #1] literal')]
    await transcript(exact)
    expect(rows(exact).map(rowText)).toEqual(['keep [Image #1] literal'])
  })

  it('does not let an attached-image send shift a markerless send ordinal', async () => {
    await mount()
    send('keep [Image #1] literal', ['file:///a.jpg'])
    send('keep literal')

    const messages = [userTextMessage('plain', 'keep literal')]
    await transcript(messages)

    expect(rows(messages).map(rowText)).toEqual(['keep literal', 'keep [Image #1] literal'])
    expect(rows(messages).map(rowImages)).toEqual([[], ['file:///a.jpg']])
  })

  it('holds every preview on the optimistic echo until the marker echo covers them all', async () => {
    await mount()
    send('', ['file:///a.jpg', 'file:///b.jpg'])

    const partial = [userTextMessage('prompt', '[Image #1]')]
    await transcript(partial)

    const partialRows = rows(partial)
    expect(partialRows.map(rowImages)).toEqual([[], ['file:///a.jpg', 'file:///b.jpg']])
    expect(state?.imagePreviewsByMessageId).toEqual({})

    const complete = [userTextMessage('prompt', '[Image #1] [Image #2]')]
    await transcript(complete)

    expect(state?.imagePreviewsByMessageId).toEqual({
      prompt: ['file:///a.jpg', 'file:///b.jpg']
    })
    expect(rows(complete).map(rowImages)).toEqual([['file:///a.jpg', 'file:///b.jpg']])
  })

  it('still binds a single-image preview to its marker-only echo', async () => {
    await mount()
    send('', ['file:///a.jpg'])

    const messages = [userTextMessage('prompt', '[Image #1]')]
    await transcript(messages)

    expect(state?.imagePreviewsByMessageId).toEqual({ prompt: ['file:///a.jpg'] })
    expect(rows(messages).map(rowImages)).toEqual([['file:///a.jpg']])
  })

  it('still strips a real marker that follows an attached image', async () => {
    await mount()
    send('look', ['file:///a.jpg'])

    const messages = [
      userTextMessage('src', '[Image: source: /tmp/a.png]'),
      userTextMessage('prompt', 'look [Image #1]')
    ]
    await transcript(messages)

    const rendered = rows(messages)
    expect(rendered.map(rowText)).toEqual(['look'])
    expect(rendered.map(rowImages)).toEqual([['file:///a.jpg']])
  })

  it('keeps a captioned multi-image echo until the transcript accounts for every image', async () => {
    await mount()
    send('compare these', ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg'])

    const partial = [
      userTextMessage('source-a', '[Image: source: /tmp/a.png]'),
      userTextMessage('prompt', 'compare these [Image #1]')
    ]
    await transcript(partial)

    expect(rows(partial).map(rowImages)).toEqual([
      ['/tmp/a.png'],
      ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']
    ])
    expect(rows(partial).map(rowText)).toEqual(['compare these', 'compare these'])
    expect(state?.imagePreviewsByMessageId).toEqual({})

    const complete = [
      userTextMessage('source-a', '[Image: source: /tmp/a.png]'),
      userTextMessage('source-b', '[Image: source: /tmp/b.png]'),
      userTextMessage('source-c', '[Image: source: /tmp/c.png]'),
      userTextMessage('complete-prompt', 'compare these [Image #1] [Image #2] [Image #3]')
    ]
    await transcript(complete)

    expect(state?.imagePreviewsByMessageId).toEqual({
      'complete-prompt': ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']
    })
    const completeRows = rows(complete)
    expect(completeRows).toHaveLength(1)
    expect(completeRows.map(rowText)).toEqual(['compare these'])
    expect(completeRows.map(rowImages)).toEqual([
      ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']
    ])
  })

  it('reconciles rapid equal captions in separate image-count namespaces', async () => {
    await mount()
    send('compare', ['file:///a.jpg'])
    send('compare', ['file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg'])

    const messages = [
      userTextMessage('source-a', '[Image: source: /tmp/a.png]'),
      userTextMessage('prompt-a', 'compare [Image #1]'),
      userTextMessage('source-b', '[Image: source: /tmp/b.png]'),
      userTextMessage('source-c', '[Image: source: /tmp/c.png]'),
      userTextMessage('source-d', '[Image: source: /tmp/d.png]'),
      userTextMessage('prompt-b', 'compare [Image #1] [Image #2] [Image #3]')
    ]
    await transcript(messages)

    const rendered = rows(messages)
    expect(rendered).toHaveLength(2)
    expect(rendered.map(rowImages)).toEqual([
      ['file:///a.jpg'],
      ['file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg']
    ])
  })

  it('reconciles rapid captionless sends in separate image-count namespaces', async () => {
    await mount()
    send('', ['file:///a.jpg'])
    send('', ['file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg'])

    const messages = [
      userTextMessage('prompt-a', '[Image #1]'),
      userTextMessage('prompt-b', '[Image #1] [Image #2] [Image #3]')
    ]
    await transcript(messages)

    const rendered = rows(messages)
    expect(rendered).toHaveLength(2)
    expect(rendered.map(rowImages)).toEqual([
      ['file:///a.jpg'],
      ['file:///b.jpg', 'file:///c.jpg', 'file:///d.jpg']
    ])
  })
})
