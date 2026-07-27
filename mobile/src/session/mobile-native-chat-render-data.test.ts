import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  buildMobileNativeChatData,
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

describe('buildMobileNativeChatData', () => {
  it('appends pending optimistic messages at the tail as user turns', () => {
    const { data } = buildMobileNativeChatData({
      messages: [assistant('a1', 'hello')],
      streamingText: undefined,
      pending: [{ id: 'p1', text: 'queued' }]
    })
    const last = data[data.length - 1]
    expect(last.id).toBe('p1')
    expect(last.role).toBe('user')
    expect(last.blocks).toEqual([{ type: 'text', text: 'queued' }])
  })

  it('renders a pending send with images as text followed by image-ref thumbnails', () => {
    const { data } = buildMobileNativeChatData({
      messages: [],
      pending: [{ id: 'p1', text: 'look', images: ['file:///a.jpg', 'file:///b.jpg'] }]
    })
    const last = data[data.length - 1]
    expect(last.role).toBe('user')
    expect(last.blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image-ref', url: 'file:///a.jpg' },
      { type: 'image-ref', url: 'file:///b.jpg' }
    ])
  })

  it('renders an image-only pending send (no text) as just the thumbnail', () => {
    const { data } = buildMobileNativeChatData({
      messages: [],
      pending: [{ id: 'p1', text: '', images: ['file:///a.jpg'] }]
    })
    expect(data[data.length - 1].blocks).toEqual([{ type: 'image-ref', url: 'file:///a.jpg' }])
  })

  it('folds transcript image marker turns into image-ref blocks (desktop parity)', () => {
    // Claude records an attached image as `[Image: source: /path]` + an
    // `[Image #1] `-prefixed caption turn; the fold must merge them into one
    // user turn with an image-ref block instead of showing raw marker text.
    const { data } = buildMobileNativeChatData({
      messages: [
        user('u1', '[Image: source: /tmp/a.png]'),
        user('u2', '[Image #1] look at this'),
        assistant('a1', 'nice photo')
      ],
      pending: []
    })
    const merged = data.find((message) => message.role === 'user')
    expect(merged?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'look at this' }
    ])
  })

  it('renders a lone image marker turn (no caption) as an image-ref block', () => {
    const { data } = buildMobileNativeChatData({
      messages: [user('u1', '[Image: source: /tmp/a.png]')],
      pending: []
    })
    expect(data[0]?.blocks).toEqual([{ type: 'image-ref', path: '/tmp/a.png' }])
  })

  it('adds a synthetic streaming bubble while the partial text leads the transcript', () => {
    const { streaming, data } = buildMobileNativeChatData({
      messages: [user('u1', 'hi')],
      streamingText: 'thinking out loud',
      pending: []
    })
    expect(streaming).toBe('thinking out loud')
    expect(data.some((m) => m.id === 'streaming')).toBe(true)
  })

  it('shows a short new streaming reply even after a longer previous turn', () => {
    // The last folded turn is a long completed reply; a short new stream must not
    // be suppressed just for being shorter than the prior turn.
    const { streaming, data } = buildMobileNativeChatData({
      messages: [assistant('a1', 'This is a long completed previous answer that ran on a while')],
      streamingText: 'Ok',
      pending: []
    })
    expect(streaming).toBe('Ok')
    expect(data.some((m) => m.id === 'streaming')).toBe(true)
  })

  it('drops the streaming bubble once the real assistant turn already contains it', () => {
    const { streaming, data } = buildMobileNativeChatData({
      messages: [assistant('a1', 'done answer')],
      streamingText: 'done',
      pending: []
    })
    expect(streaming).toBeNull()
    expect(data.some((m) => m.id === 'streaming')).toBe(false)
  })

  it('returns no streaming bubble for empty/whitespace streaming text', () => {
    expect(
      buildMobileNativeChatData({ messages: [], streamingText: '   ', pending: [] }).streaming
    ).toBeNull()
    expect(buildMobileNativeChatData({ messages: [], pending: [] }).streaming).toBeNull()
  })
})
