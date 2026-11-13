import { MobileNativeChatVisualContext } from '../visual/mobile-native-chat-visual-context'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

function toolRow(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: { command: id }, state: 'completed' }],
    timestamp: null,
    source: 'transcript'
  }
}

function answer(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Done.' }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('how the structured lane draws its rows, as desktop does', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders generated output in the shipping answer list through collapse and expansion', () => {
    const generated: NativeChatMessage = {
      ...answer('image'),
      blocks: [
        { type: 'text' as const, text: 'Generated image', presentation: 'generated-image' },
        { type: 'image-ref' as const, path: '/tmp/elephant.png' }
      ]
    }
    const messages = [userMessage('u1'), toolRow('work'), answer('final'), generated]
    act(() => {
      renderer = create(
        createElement(Harness, {
          messages,
          enabled: true,
          isWorking: false,
          settledTurns: new Map([['u1', { startedAt: 0, workedSeconds: 3 }]])
        })
      )
    })
    const read = () => renderer!.root.findByType(Result).props.disclosure
    const final = read().listMessages.find((row: NativeChatMessage) => row.id === 'final')!
    expect(final.blocks).toEqual([
      { type: 'text', text: 'Done.' },
      { type: 'image-ref' as const, path: '/tmp/elephant.png' }
    ])
    expect(read().resolveRow(2, final).foldedAway).not.toBe(true)
    expect(read().resolveRow(1, messages[1]).foldedAway).toBe(true)
    act(() => read().onToggleTurn('u1'))
    expect(
      read().listMessages.flatMap((row: NativeChatMessage) =>
        row.blocks.filter((block) => block.type === 'image-ref')
      )
    ).toEqual([{ type: 'image-ref' as const, path: '/tmp/elephant.png' }])
    expect(read().listMessages.find((row: NativeChatMessage) => row.id === 'final')).toBe(final)
  })

  it('switches the shipping answer projection with visual availability on unchanged rows', () => {
    const messages = [
      userMessage('u1'),
      {
        ...answer('image'),
        blocks: [
          { type: 'text' as const, text: 'Generated image', presentation: 'generated-image' },
          { type: 'image-ref' as const, path: '/tmp/p.png' }
        ]
      },
      {
        ...answer('final'),
        blocks: [
          { type: 'text' as const, text: '::orca-visual{file="plot.html" title="![](/tmp/p.png)"}' }
        ]
      }
    ]
    const settledTurns = new Map([['u1', { startedAt: 0, workedSeconds: 3 }]])
    const renderVisual = () => null
    const update = (visuals: boolean) => {
      const tree = createElement(
        MobileNativeChatVisualContext.Provider,
        { value: visuals ? renderVisual : null },
        createElement(Harness, { messages, enabled: true, isWorking: false, settledTurns })
      )
      act(() => {
        if (renderer) {
          renderer.update(tree)
        } else {
          renderer = create(tree)
        }
      })
    }
    const images = () =>
      renderer!.root
        .findByType(Result)
        .props.disclosure.listMessages.flatMap((row: NativeChatMessage) =>
          row.blocks.filter((block) => block.type === 'image-ref')
        )
    update(false)
    expect(images()).toEqual([])
    update(true)
    expect(images()).toEqual([{ type: 'image-ref' as const, path: '/tmp/p.png' }])
    act(() => renderer!.root.findByType(Result).props.disclosure.onToggleTurn('u1'))
    expect(images()).toEqual([{ type: 'image-ref' as const, path: '/tmp/p.png' }])
    update(false)
    expect(images()).toEqual([])
  })

  it.each([
    [['# ![](/tmp/p.png)'], true],
    [['![](/tmp/p.png)'], false],
    [['![][p]', '[p]: /tmp/p.png'], true]
  ] as const)(
    'keeps output unless independently rendered prose actually embeds it: %j',
    (texts, retained) => {
      const messages = [
        userMessage('u1'),
        {
          ...answer('image'),
          blocks: [
            { type: 'text' as const, text: 'Generated image', presentation: 'generated-image' },
            { type: 'image-ref' as const, path: '/tmp/p.png' }
          ]
        },
        { ...answer('final'), blocks: texts.map((text) => ({ type: 'text' as const, text })) }
      ]
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            settledTurns: new Map([['u1', { startedAt: 0, workedSeconds: 3 }]])
          })
        )
      })
      const final = renderer!.root
        .findByType(Result)
        .props.disclosure.listMessages.find((row: NativeChatMessage) => row.id === 'final')!
      expect(
        final.blocks.filter(
          (block: NativeChatMessage['blocks'][number]) => block.type === 'image-ref'
        )
      ).toEqual(retained ? [{ type: 'image-ref' as const, path: '/tmp/p.png' }] : [])
    }
  )
})
