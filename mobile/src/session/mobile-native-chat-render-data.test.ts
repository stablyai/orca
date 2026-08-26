import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages,
  mobileNativeChatEmptyState
} from './mobile-native-chat-render-data'

function assistant(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 0,
    source: 'transcript'
  }
}

function user(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 0, source: 'transcript' }
}

describe('mobileNativeChatEmptyState', () => {
  it('invites a first message naming the agent, matching desktop copy', () => {
    // waiting-session (live agent, no transcript) and ready (loaded, empty) both
    // resolve to the shared "empty" copy with the agent label substituted.
    const waiting = mobileNativeChatEmptyState('waiting-session', 'claude')
    expect(waiting).toEqual({
      title: 'Start a chat with Claude',
      subtitle: 'Ask Claude to inspect code, explain output, or make a change.'
    })
    expect(mobileNativeChatEmptyState('ready', 'codex')?.title).toBe('Start a chat with Codex')
  })

  it('invites a first message while the transcript file is still unwritten', () => {
    // The spinner is already gone by then, so a bare list would read as broken.
    expect(mobileNativeChatEmptyState('awaiting-transcript', 'claude')?.title).toBe(
      'Start a chat with Claude'
    )
  })

  it('falls back to "the agent" when the agent is unknown', () => {
    expect(mobileNativeChatEmptyState('waiting-session', null)?.title).toBe(
      'Start a chat with the agent'
    )
  })

  it('prefers the provided error message over the default subtitle', () => {
    expect(mobileNativeChatEmptyState('error', 'claude', 'boom')?.subtitle).toBe('boom')
    expect(mobileNativeChatEmptyState('error', 'claude')?.subtitle).toBe(
      'The transcript could not be read. Toggle back to the terminal to keep working.'
    )
  })

  it('returns null for states that show no empty copy', () => {
    expect(mobileNativeChatEmptyState('loading', 'claude')).toBeNull()
    expect(mobileNativeChatEmptyState('idle', 'claude')).toBeNull()
  })
})

/** Mirrors the view: fold the raw transcript, then assemble the list. */
function build(
  messages: NativeChatMessage[],
  streaming: string | null,
  pending: Parameters<typeof buildMobileNativeChatTransientData>[0]['pending']
): NativeChatMessage[] {
  return buildMobileNativeChatTransientData({
    folded: foldMobileNativeChatMessages(messages),
    streaming,
    pending
  }).data
}

describe('buildMobileNativeChatTransientData', () => {
  it('appends pending optimistic messages at the tail as user turns', () => {
    const data = build([assistant('a1', 'hello')], null, [{ id: 'p1', text: 'queued' }])
    const last = data[data.length - 1]
    expect(last.id).toBe('p1')
    expect(last.role).toBe('user')
    expect(last.blocks).toEqual([{ type: 'text', text: 'queued' }])
  })

  it('renders a pending send with images as text followed by image-ref thumbnails', () => {
    const data = build([], null, [
      { id: 'p1', text: 'look', images: ['file:///a.jpg', 'file:///b.jpg'] }
    ])
    const last = data[data.length - 1]
    expect(last.role).toBe('user')
    expect(last.blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image-ref', url: 'file:///a.jpg' },
      { type: 'image-ref', url: 'file:///b.jpg' }
    ])
  })

  it('renders an image-only pending send (no text) as just the thumbnail', () => {
    const data = build([], null, [{ id: 'p1', text: '', images: ['file:///a.jpg'] }])
    expect(data[data.length - 1].blocks).toEqual([{ type: 'image-ref', url: 'file:///a.jpg' }])
  })

  it('folds transcript image marker turns into image-ref blocks (desktop parity)', () => {
    // Claude records an attached image as `[Image: source: /path]` plus a
    // caption turn carrying `[Image #1]`; the fold must merge them into one
    // user turn with an image-ref block instead of showing raw marker text.
    const data = build(
      [
        user('u1', '[Image: source: /tmp/a.png]'),
        user('u2', '[Image #1] look at this'),
        assistant('a1', 'nice photo')
      ],
      null,
      []
    )
    const merged = data.find((message) => message.role === 'user')
    expect(merged?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('folds a trailing-marker image echo into one user bubble', () => {
    const data = build(
      [user('u1', '[Image: source: /tmp/a.png]'), user('u2', 'look at this[Image #1]')],
      null,
      []
    )

    expect(data).toHaveLength(1)
    expect(data[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('renders a lone image marker turn (no caption) as an image-ref block', () => {
    const data = build([user('u1', '[Image: source: /tmp/a.png]')], null, [])
    expect(data[0]?.blocks).toEqual([{ type: 'image-ref', path: '/tmp/a.png' }])
  })

  it('keeps the phone-local image visible when the transcript replaces its optimistic echo', () => {
    const folded = foldMobileNativeChatMessages([
      user('source', '[Image: source: /tmp/a.png]'),
      user('prompt', '[Image #1] look at this')
    ])
    const result = buildMobileNativeChatTransientData({
      folded,
      streaming: null,
      pending: [],
      imagePreviewsByMessageId: { prompt: ['file:///phone-photo.jpg'] }
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png', url: 'file:///phone-photo.jpg' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('restores the local preview onto a marker-only transcript turn', () => {
    const result = buildMobileNativeChatTransientData({
      folded: foldMobileNativeChatMessages([user('prompt', '[Image #1]')]),
      streaming: null,
      pending: [],
      imagePreviewsByMessageId: { prompt: ['file:///phone-photo.jpg'] }
    })

    expect(result.data[0]?.blocks).toEqual([{ type: 'image-ref', url: 'file:///phone-photo.jpg' }])
  })

  it('appends a synthetic bubble for gated streaming text, between transcript and pending', () => {
    // Whether text streams at all is the gate's call
    // (`mobile-native-chat-streaming-gate.test.ts`); this only places it.
    const data = build([user('u1', 'hi')], 'thinking out loud', [{ id: 'p1', text: 'queued' }])
    expect(data.map((message) => message.id)).toEqual(['u1', 'streaming', 'p1'])
    expect(data[1].blocks).toEqual([{ type: 'text', text: 'thinking out loud' }])
  })

  it('omits the bubble when the gate withheld the streaming text', () => {
    const data = build([assistant('a1', 'done answer')], null, [])
    expect(data.some((message) => message.id === 'streaming')).toBe(false)
  })
})
