import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { publishPageDeviceStore } from '../../../mobile-web-shell/bridge/page-device-store'
import { encodeDeviceStoreValue } from '../../../device-store/device-store-value-codec'
import { chatTranscriptStoreKey } from './mobile-native-chat-transcript-store'
import {
  clearMobileNativeChatDisplay,
  mobileNativeChatMessagesAfterDisplayClear,
  useMobileNativeChatDisplayMessages
} from './mobile-native-chat-display-clear'

it('hides cleared transcript rows and their revisions while showing subsequent output', () => {
  const boundary: NativeChatMessage = {
    id: 'answer',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'already displayed' }],
    timestamp: 2000,
    source: 'transcript',
    transcriptOrder: 20
  }
  const rows: NativeChatMessage[] = [
    { ...boundary, id: 'earlier', transcriptOrder: 10 },
    { ...boundary, blocks: [{ type: 'text', text: 'revised old answer' }] },
    { ...boundary, id: 'answer:reasoning', role: 'reasoning' },
    { ...boundary, id: 'new-answer', timestamp: 1000, transcriptOrder: 30 }
  ]
  expect(mobileNativeChatMessagesAfterDisplayClear(rows, boundary).map((row) => row.id)).toEqual([
    'new-answer'
  ])
})

it('keeps a revised cleared message hidden on older hosts without transcript order', () => {
  const boundary: NativeChatMessage = {
    id: 'old',
    role: 'assistant',
    blocks: [],
    timestamp: 1000,
    source: 'transcript'
  }
  expect(
    mobileNativeChatMessagesAfterDisplayClear(
      [
        { ...boundary, timestamp: 3000 },
        { ...boundary, id: 'next', timestamp: 4000 }
      ],
      boundary
    ).map((row) => row.id)
  ).toEqual(['next'])
})

it('restores a saved display cutoff, publishes later clears, and leaves another chat unchanged', async () => {
  const boundary: NativeChatMessage = {
    id: 'old',
    role: 'assistant',
    blocks: [],
    timestamp: 1000,
    source: 'transcript',
    transcriptOrder: 10
  }
  const rows = [boundary, { ...boundary, id: 'new', transcriptOrder: 20 }]
  const identity = 'display-clear-persisted-chat'
  const stored = new Map([
    [
      `${chatTranscriptStoreKey(identity)}:display-clear`,
      encodeDeviceStoreValue({ row: boundary, preview: null })
    ]
  ])
  publishPageDeviceStore({
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => stored.get(key) ?? null)
    }),
    write: async (_table, ops) => {
      for (const op of ops) {
        if (op.value === null) {
          stored.delete(op.key)
        } else {
          stored.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  })
  let shown: string[] = []
  let canLoadEarlier = false
  function Harness({
    scope,
    messages = rows
  }: {
    scope: string
    messages?: NativeChatMessage[]
  }): null {
    const display = useMobileNativeChatDisplayMessages(scope, messages)
    shown = display.messages.map((row) => row.id)
    canLoadEarlier = display.canLoadEarlier
    return null
  }
  let renderer: ReactTestRenderer | null = null
  try {
    await act(async () => {
      renderer = create(createElement(Harness, { scope: identity }))
    })
    expect(shown).toEqual(['new'])
    expect(canLoadEarlier).toBe(false)
    await act(async () => {
      renderer?.update(createElement(Harness, { scope: identity, messages: [rows[1]!] }))
    })
    expect(shown).toEqual(['new'])
    expect(canLoadEarlier).toBe(true)
    await act(async () => {
      await clearMobileNativeChatDisplay(identity, rows[1]!)
    })
    expect(shown).toEqual([])
    expect(rows.map((row) => row.id)).toEqual(['old', 'new'])
    await act(async () => {
      renderer?.update(createElement(Harness, { scope: 'display-clear-other-chat' }))
    })
    expect(shown).toEqual(['old', 'new'])
    await act(async () => {
      renderer?.update(createElement(Harness, { scope: identity }))
    })
    expect(shown).toEqual([])
  } finally {
    await act(async () => {
      renderer?.unmount()
    })
    publishPageDeviceStore(null)
  }
})

it('clears a live preview without transcript rows and shows subsequent output or a new turn', async () => {
  const identity = 'display-clear-live-preview'
  const rows: NativeChatMessage[] = []
  let shown: string | null = null
  let transcript: string[] = []
  function Harness({
    text,
    turnStartedAt = 100,
    messages = rows
  }: {
    text: string | null
    turnStartedAt?: number
    messages?: NativeChatMessage[]
  }): null {
    const display = useMobileNativeChatDisplayMessages(identity, messages, { text, turnStartedAt })
    shown = display.streaming
    transcript = display.messages.flatMap((row) =>
      row.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    )
    return null
  }
  let renderer: ReactTestRenderer | null = null
  try {
    await act(async () => {
      renderer = create(createElement(Harness, { text: 'already seen' }))
    })
    expect(shown).toBe('already seen')
    await act(async () => {
      await clearMobileNativeChatDisplay(identity, null, {
        text: 'already seen',
        turnStartedAt: 100
      })
    })
    expect(shown).toBeNull()
    await act(async () => {
      renderer?.update(createElement(Harness, { text: 'already seen plus new' }))
    })
    expect(shown).toBe('plus new')
    const caughtUp: NativeChatMessage = {
      id: 'reply',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'already seen plus new' }],
      timestamp: 150,
      source: 'transcript',
      transcriptOrder: 10
    }
    const currentUser: NativeChatMessage = {
      ...caughtUp,
      id: 'current-question',
      role: 'user',
      timestamp: 50,
      transcriptOrder: 5,
      blocks: [{ type: 'text', text: 'current question' }]
    }
    await act(async () => {
      renderer?.update(createElement(Harness, { text: null, messages: [currentUser, caughtUp] }))
    })
    expect(transcript).toEqual(['current question', 'plus new'])
    const nextTurn: NativeChatMessage[] = [
      caughtUp,
      {
        ...caughtUp,
        id: 'next-question',
        role: 'user',
        transcriptOrder: 20,
        blocks: [{ type: 'text', text: 'next question' }]
      },
      {
        ...caughtUp,
        id: 'next-reply',
        transcriptOrder: 30,
        blocks: [{ type: 'text', text: 'already seen' }]
      }
    ]
    await act(async () => {
      renderer?.update(
        createElement(Harness, { text: null, messages: nextTurn, turnStartedAt: 200 })
      )
    })
    expect(transcript).toEqual(['plus new', 'next question', 'already seen'])
    await act(async () => {
      renderer?.update(createElement(Harness, { text: 'already seen', turnStartedAt: 200 }))
    })
    expect(shown).toBe('already seen')
  } finally {
    await act(async () => {
      renderer?.unmount()
    })
  }
})
