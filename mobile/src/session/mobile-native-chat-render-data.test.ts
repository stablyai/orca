import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { buildMobileNativeChatData, statusHint } from './mobile-native-chat-render-data'

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

describe('statusHint', () => {
  it('describes the waiting-session state', () => {
    expect(statusHint('waiting-session')).toMatch(/Waiting for the agent/)
  })

  it('prefers the provided error message, falling back to a default', () => {
    expect(statusHint('error', 'boom')).toBe('boom')
    expect(statusHint('error')).toBe('Could not load the conversation.')
  })

  it('returns null for non-hint states', () => {
    expect(statusHint('ready')).toBeNull()
    expect(statusHint('loading')).toBeNull()
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
