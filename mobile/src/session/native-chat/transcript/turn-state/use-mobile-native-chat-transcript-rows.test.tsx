import { MobileNativeChatVisualContext } from '../../visual/mobile-native-chat-visual-context'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'
import { useMobileNativeChatTranscriptRows } from './use-mobile-native-chat-transcript-rows'

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

  it('hides a settled quiet reply and its bar, but keeps a pull request turn visible', () => {
    const worker: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }
    const note: NativeChatMessage = {
      ...answer('note'),
      role: 'system',
      blocks: [],
      botItemNote: {
        noteId: 'note',
        by: 'bot',
        entries: [
          {
            uid: 'i',
            number: 1,
            title: 'Export',
            status: 'working',
            event: 'commented',
            text: 'Yes.'
          }
        ]
      }
    }
    const quietReply = (id: string): NativeChatMessage => ({
      ...answer(id),
      blocks: [{ type: 'text', text: 'NO_REPLY' }]
    })
    act(() => {
      renderer = create(
        createElement(Harness, {
          messages: [
            { ...userMessage('quiet-mail'), from: worker },
            note,
            quietReply('quiet-reply'),
            { ...userMessage('pr-mail'), from: worker },
            toolRow('gh pr create --fill'),
            quietReply('pr-reply')
          ],
          enabled: true,
          isWorking: false,
          settledTurns: new Map([
            ['quiet-mail', { startedAt: 0, workedSeconds: 9 }],
            ['pr-mail', { startedAt: 10_000, workedSeconds: 4 }]
          ])
        })
      )
    })
    const disclosure = renderer!.root.findByType(Result).props.disclosure
    expect(disclosure.listMessages.map((row: NativeChatMessage) => row.id)).toEqual([
      'quiet-mail',
      'note',
      'pr-mail',
      'gh pr create --fill',
      'pr-reply'
    ])
    const bars = disclosure.listMessages.flatMap((row: NativeChatMessage, index: number) => {
      const status = disclosure.resolveRow(index, row).turnStatus
      return status ? [status.workedSeconds] : []
    })
    expect(bars).toEqual([4])
  })

  it('renders generated output in the shipping answer list through collapse and expansion', () => {
    const generated: NativeChatMessage = {
      ...answer('image'),
      blocks: [
        { type: 'text' as const, text: 'Generated image', presentation: 'generated-image' },
        { type: 'image-ref' as const, path: '/tmp/elephant.png' }
      ]
    }
    const cardAnswer: NativeChatMessage = {
      ...userMessage('card-answer'),
      orcaNotice: 'card-answer'
    }
    const quiet: NativeChatMessage = {
      ...answer('quiet'),
      blocks: [{ type: 'text', text: 'NO_REPLY' }]
    }
    const messages = [
      userMessage('u1'),
      toolRow('work'),
      answer('final'),
      generated,
      cardAnswer,
      quiet
    ]
    act(() => {
      renderer = create(
        createElement(Harness, {
          messages,
          enabled: true,
          isWorking: false,
          settledTurns: new Map([
            ['u1', { startedAt: 0, workedSeconds: 3 }],
            ['card-answer', { startedAt: 4_000, workedSeconds: 7 }]
          ])
        })
      )
    })
    const read = () => renderer!.root.findByType(Result).props.disclosure
    expect(read().listMessages.map((row: NativeChatMessage) => row.id)).not.toContain('card-answer')
    expect(read().listMessages.map((row: NativeChatMessage) => row.id)).not.toContain('quiet')
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

  it('keeps item notes touching across a turn that changed no files, and apart under a diff', () => {
    const note = (id: string): NativeChatMessage => ({
      id,
      role: 'system',
      blocks: [],
      timestamp: null,
      source: 'transcript',
      botItemNote: {
        noteId: id,
        by: 'bot',
        entries: [{ uid: id, number: 1, title: id, status: 'planned', event: 'made' }]
      }
    })
    const rows = [note('a'), note('b')]
    let joins: ReadonlyMap<number, string> = new Map()
    function Rows({ turnDiffs }: { turnDiffs: ReadonlyMap<string, unknown> }) {
      joins = useMobileNativeChatTranscriptRows({
        enabled: true,
        rows,
        turnKeys: ['t1', 't2'],
        receipts: null,
        completedByTurn: {},
        expandedTurnKeys: new Set(),
        liveReasoningId: undefined,
        turnDiffs
      }).itemNoteJoins
      return null
    }
    // The turn-diff map has an entry for every turn's last row, undefined when nothing changed.
    act(() => {
      renderer = create(createElement(Rows, { turnDiffs: new Map([['a', undefined]]) }))
    })
    expect(Object.fromEntries(joins)).toEqual({ 0: 'below', 1: 'above' })

    act(() => renderer!.update(createElement(Rows, { turnDiffs: new Map([['a', { files: [] }]]) })))
    expect(joins.size).toBe(0)
  })
})
