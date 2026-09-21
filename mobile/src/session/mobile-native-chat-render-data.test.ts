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
    messages,
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
      messages: folded,
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
      messages: [user('prompt', '[Image #1]')],
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

describe('foldMobileNativeChatMessages', () => {
  function toolCall(id: string): NativeChatMessage {
    return {
      id,
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'command -v orca-ide' } }],
      timestamp: 0,
      source: 'transcript'
    }
  }

  function toolResult(id: string, output: string): NativeChatMessage {
    return {
      id,
      role: 'tool',
      blocks: [{ type: 'tool-result', output }],
      timestamp: 0,
      source: 'transcript'
    }
  }

  // The chat reads a 40-message tail, so the window regularly opens on a result
  // whose `tool_use` is older than the window. It used to render as its own
  // bubble of raw shell output with no owning call.
  it('drops a leading tool result whose call is older than the read window', () => {
    const folded = foldMobileNativeChatMessages([
      toolResult('orphan', 'Exit code 1\norca-ide not found'),
      assistant('a1', 'Falling back to the installed binary.')
    ])

    expect(folded.map((message) => message.id)).toEqual(['a1'])
  })

  it('still folds a result whose call is inside the window', () => {
    const folded = foldMobileNativeChatMessages([
      assistant('a1', 'Checking which binary is on PATH.'),
      toolCall('c1'),
      toolResult('r1', 'orca-ide not found')
    ])

    expect(folded).toHaveLength(1)
    expect(folded[0]?.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool-call',
      'tool-result'
    ])
  })

  it('keeps a mixed Claude tool result with a harness sidecar paired', () => {
    const folded = foldMobileNativeChatMessages([
      toolCall('c1'),
      {
        id: 'mixed',
        role: 'user',
        blocks: [
          { type: 'tool-result', output: 'important output' },
          { type: 'text', text: '<system-reminder>continue</system-reminder>' }
        ],
        timestamp: 0,
        source: 'transcript'
      }
    ])

    expect(folded[0]?.blocks).toEqual([
      { type: 'tool-call', name: 'Bash', input: { command: 'command -v orca-ide' } },
      { type: 'tool-result', output: 'important output' }
    ])
  })

  it('keeps a hidden interruption from authorizing a later result', () => {
    const folded = foldMobileNativeChatMessages([
      toolCall('c1'),
      {
        id: 'interrupt',
        role: 'user',
        blocks: [{ type: 'text', text: '[Request interrupted by user]' }],
        timestamp: 1,
        source: 'transcript'
      },
      toolResult('orphan', 'stale output')
    ])

    expect(folded.map((message) => message.id)).toEqual(['c1'])
    expect(folded[0]?.blocks).toEqual([
      { type: 'tool-call', name: 'Bash', input: { command: 'command -v orca-ide' } }
    ])
  })
})

// Claude consumes a mid-turn send through a `queued_command` attachment and writes
// no `type:"user"` record for it, so that echo has no row to match - ever. What
// made the conversation read as scrambled was not the unmatched echo itself but
// where it rendered: appended after every turn, so it re-read below each new one.
describe('buildMobileNativeChatTransientData anchoring', () => {
  function row(id: string, role: 'user' | 'assistant', text: string): NativeChatMessage {
    return { id, role, blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
  }

  it('keeps an unmatched echo where it was sent instead of below later turns', () => {
    const folded = [row('m1', 'user', 'earlier'), row('m2', 'assistant', 'on it')]
    const { data } = buildMobileNativeChatTransientData({
      messages: folded,
      folded,
      streaming: null,
      pending: [{ id: 'p1', text: 'a mid-turn send', baselineTailMessageId: 'm2' }]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'm2', 'p1'])

    // The agent keeps working. The echo must NOT drift below the new turns.
    const later = [
      ...folded,
      row('m3', 'assistant', 'still working'),
      row('m4', 'assistant', 'done')
    ]
    const { data: after } = buildMobileNativeChatTransientData({
      messages: later,
      folded: later,
      streaming: null,
      pending: [{ id: 'p1', text: 'a mid-turn send', baselineTailMessageId: 'm2' }]
    })
    expect(after.map((m) => m.id)).toEqual(['m1', 'm2', 'p1', 'm3', 'm4'])
  })

  it('reproduces the reported replay: stale echoes stay in place, not stacked at the tail', () => {
    const folded = [
      row('m1', 'user', 'first question'),
      row('m2', 'assistant', 'answering'),
      row('m3', 'assistant', 'newest turn')
    ]
    const { data } = buildMobileNativeChatTransientData({
      messages: folded,
      folded,
      streaming: null,
      pending: [
        { id: 'p1', text: 'sent against m1', baselineTailMessageId: 'm1' },
        { id: 'p2', text: 'sent against m2', baselineTailMessageId: 'm2' }
      ]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'p1', 'm2', 'p2', 'm3'])
  })

  it('keeps send order among echoes sharing one anchor', () => {
    const { data } = buildMobileNativeChatTransientData({
      messages: [row('m1', 'assistant', 'ready')],
      folded: [row('m1', 'assistant', 'ready')],
      streaming: null,
      pending: [
        { id: 'p1', text: 'first', baselineTailMessageId: 'm1' },
        { id: 'p2', text: 'second', baselineTailMessageId: 'm1' }
      ]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'p1', 'p2'])
  })

  it('falls back to the tail when the send captured no baseline', () => {
    const { data } = buildMobileNativeChatTransientData({
      messages: [row('m1', 'assistant', 'ready')],
      folded: [row('m1', 'assistant', 'ready')],
      streaming: null,
      pending: [{ id: 'p1', text: 'no baseline yet', baselineTailMessageId: null }]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'p1'])
  })

  it('falls back to the tail when the captured row left the raw window', () => {
    const { data } = buildMobileNativeChatTransientData({
      messages: [row('m1', 'assistant', 'ready')],
      folded: [row('m1', 'assistant', 'ready')],
      streaming: null,
      pending: [{ id: 'p1', text: 'anchored to a folded-away row', baselineTailMessageId: 'gone' }]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'p1'])
  })

  it('keeps an echo before later turns when its folded baseline leads the raw window', () => {
    const messages = [
      row('noise', 'user', '<system-reminder>hidden boundary'),
      row('a1', 'assistant', 'arrived later')
    ]
    const folded = foldMobileNativeChatMessages(messages)
    expect(folded.map((message) => message.id)).toEqual(['a1'])

    const { data } = buildMobileNativeChatTransientData({
      messages,
      folded,
      streaming: null,
      pending: [
        { id: 'p1', text: 'sent after the hidden boundary', baselineTailMessageId: 'noise' }
      ]
    })
    expect(data.map((message) => message.id)).toEqual(['p1', 'a1'])
  })

  it('still puts the streaming bubble after the transcript', () => {
    const { data } = buildMobileNativeChatTransientData({
      messages: [row('m1', 'user', 'hi')],
      folded: [row('m1', 'user', 'hi')],
      streaming: 'thinking',
      pending: [{ id: 'p1', text: 'echo', baselineTailMessageId: 'm1' }]
    })
    expect(data.map((m) => m.id)).toEqual(['m1', 'p1', 'streaming'])
  })

  it('anchors a send captured against a tool row to its folded assistant', () => {
    const messages: NativeChatMessage[] = [
      row('a1', 'assistant', 'working'),
      {
        id: 'tool',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' } }],
        timestamp: 2,
        source: 'transcript'
      },
      row('a2', 'assistant', 'done')
    ]
    const folded = foldMobileNativeChatMessages(messages)
    expect(folded.map((message) => message.id)).toEqual(['a1', 'a2'])

    const { data } = buildMobileNativeChatTransientData({
      messages,
      folded,
      streaming: null,
      pending: [{ id: 'p1', text: 'sent during the tool', baselineTailMessageId: 'tool' }]
    })
    expect(data.map((message) => message.id)).toEqual(['a1', 'p1', 'a2'])
  })

  it('anchors after the prompt that absorbed an earlier image-source row', () => {
    const messages = [
      row('a1', 'assistant', 'ready'),
      user('source', '[Image: source: /tmp/earlier.png]'),
      user('prompt', '[Image #1] earlier image'),
      row('a2', 'assistant', 'done')
    ]
    const folded = foldMobileNativeChatMessages(messages)
    expect(folded.map((message) => message.id)).toEqual(['a1', 'prompt', 'a2'])

    const { data } = buildMobileNativeChatTransientData({
      messages,
      folded,
      streaming: null,
      pending: [{ id: 'p1', text: 'sent after the image source', baselineTailMessageId: 'source' }]
    })
    expect(data.map((message) => message.id)).toEqual(['a1', 'prompt', 'p1', 'a2'])
  })
})
