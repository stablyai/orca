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

const fold = (messages: NativeChatMessage[]) => foldMobileNativeChatMessages(messages, 'claude')

describe('mobileNativeChatEmptyState', () => {
  it('invites a first message into a loaded, empty chat, matching desktop copy', () => {
    expect(mobileNativeChatEmptyState('ready', 'codex')).toEqual({
      title: 'Start a chat with Codex',
      subtitle: 'Ask Codex to inspect code, explain output, or make a change.'
    })
  })

  it.each(['waiting-session', 'awaiting-transcript'] as const)(
    'says the conversation is not found yet while %s, never that the chat is new',
    (status) => {
      expect(mobileNativeChatEmptyState(status, 'claude')).toEqual({
        title: "Can't find this conversation yet",
        subtitle:
          'Send a message to start one, or open the terminal view to see what Claude is doing.'
      })
    }
  )

  it('invites a first message when the running agent reported a session with no transcript yet', () => {
    expect(mobileNativeChatEmptyState('awaiting-transcript', 'claude', undefined, true)).toEqual({
      title: 'Start a chat with Claude',
      subtitle: 'Ask Claude to inspect code, explain output, or make a change.'
    })
  })

  it('falls back to "the agent" when the agent is unknown', () => {
    expect(mobileNativeChatEmptyState('ready', null)?.title).toBe('Start a chat with the agent')
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

function build(
  messages: NativeChatMessage[],
  streaming: string | null,
  pending: Parameters<typeof buildMobileNativeChatTransientData>[0]['pending']
): NativeChatMessage[] {
  return buildMobileNativeChatTransientData({
    folded: fold(messages),
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

  it('times an echo from when it was sent, as desktop times its pending sends', () => {
    const data = build([assistant('a1', 'hello')], null, [
      { id: 'p1', text: 'queued', sentAt: 1_792_024_037_937 }
    ])
    expect(data.at(-1)?.timestamp).toBe(1_792_024_037_937)
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

  it('leaves out an unrecognised provider event with no words, but keeps failures and sentences', () => {
    const frameRow = (
      id: string,
      kind: string,
      text: string,
      tone?: string
    ): NativeChatMessage => ({
      id,
      role: 'system',
      timestamp: 0,
      source: 'transcript',
      blocks: [
        {
          type: 'text',
          text,
          ...(tone ? { tone } : {}),
          providerFrame: {
            provider: 'codex',
            kind,
            payload: { head: '{}', byteLength: 2, digest: 'digest', truncated: false }
          }
        }
      ]
    })
    const folded = fold([
      frameRow('wordless', 'notification:future/event', 'codex · notification:future/event'),
      frameRow(
        'failure',
        'notification:future/failure',
        'codex · notification:future/failure',
        'error'
      ),
      frameRow('sentence', 'notification:warning', 'Sandbox is degraded.'),
      assistant('a1', 'done')
    ])
    expect(folded.map((message) => message.id)).toEqual(['failure', 'sentence', 'a1'])
  })

  it('draws a turn’s subagents, each written as its own row, as one roster row', () => {
    const own = (id: string): NativeChatMessage => ({
      id: `subagent:${id}`,
      role: 'system',
      blocks: [
        { type: 'text', text: `Kicked off subagent ${id}` },
        { type: 'subagent', id, label: id, state: 'working', groupId: 'turn-1' }
      ],
      timestamp: 0,
      source: 'transcript'
    })
    const folded = fold([user('u1', 'audit'), own('a'), assistant('a1', 'started'), own('b')])
    expect(folded.map((message) => message.id)).toEqual(['u1', 'subagent:a', 'a1'])
    expect(folded[1]?.blocks).toEqual([
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [
          { id: 'a', label: 'a', state: 'working' },
          { id: 'b', label: 'b', state: 'working' }
        ]
      }
    ])
  })

  it('renders a lone image marker turn (no caption) as an image-ref block', () => {
    const data = build([user('u1', '[Image: source: /tmp/a.png]')], null, [])
    expect(data[0]?.blocks).toEqual([{ type: 'image-ref', path: '/tmp/a.png' }])
  })

  it('keeps the phone-local image visible when the transcript replaces its optimistic echo', () => {
    const folded = fold([
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
      folded: fold([user('prompt', '[Image #1]')]),
      streaming: null,
      pending: [],
      imagePreviewsByMessageId: { prompt: ['file:///phone-photo.jpg'] }
    })

    expect(result.data[0]?.blocks).toEqual([{ type: 'image-ref', url: 'file:///phone-photo.jpg' }])
  })

  it('appends a synthetic bubble for gated streaming text, between transcript and pending', () => {
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

  // Read windows may begin after tool_use; leading orphan results must not become raw-output bubbles.
  it('drops a leading tool result whose call is older than the read window', () => {
    const folded = fold([
      toolResult('orphan', 'Exit code 1\norca-ide not found'),
      assistant('a1', 'Falling back to the installed binary.')
    ])

    expect(folded.map((message) => message.id)).toEqual(['a1'])
  })

  function planFrame(head: string): NativeChatMessage {
    return {
      id: 'plan',
      role: 'system',
      timestamp: 0,
      source: 'transcript',
      blocks: [
        {
          type: 'text',
          text: 'codex · notification:turn/plan/updated',
          providerFrame: {
            provider: 'codex',
            kind: 'notification:turn/plan/updated',
            payload: { head, byteLength: head.length, digest: 'digest', truncated: false }
          }
        }
      ]
    }
  }

  it('draws a Codex plan update where it happened, as an update_plan call', () => {
    const folded = fold([
      assistant('a1', 'Working.'),
      toolCall('c1'),
      toolResult('r1', 'ok'),
      planFrame('{"plan":[{"step":"Port rows","status":"inProgress"}]}'),
      toolCall('c2'),
      toolResult('r2', 'ok')
    ])
    expect(folded.map((message) => message.id)).toEqual(['a1', 'plan', 'c2'])
    expect(folded[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'update_plan', state: 'completed' }]
    })
  })

  it('draws nothing for a plan update it cannot read', () => {
    const folded = fold([assistant('a1', 'Working.'), planFrame('{}')])
    expect(folded.map((message) => message.id)).toEqual(['a1'])
  })

  it('still folds a result whose call is inside the window', () => {
    const folded = fold([
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
    const folded = fold([
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

  it('draws a skill command the user ran as their message, as desktop does', () => {
    const folded = fold([
      {
        ...user(
          'd7306d00',
          '<command-message>hello</command-message>\n<command-name>/hello</command-name>\n<command-args>Kelvin</command-args>'
        ),
        parentId: 'f615a2bf'
      },
      { ...assistant('0d3481c0', 'Hello, Kelvin!'), parentId: 'fa9d5ee6' }
    ])

    expect(folded.map((message) => [message.role, message.blocks])).toEqual([
      ['user', [{ type: 'text', text: '/hello Kelvin' }]],
      ['assistant', [{ type: 'text', text: 'Hello, Kelvin!' }]]
    ])
  })
})

// Claude may consume queued commands without a user record; unmatched echoes must stay at their send position rather than trail every later turn.
describe("mobile shows the conversation, never a subagent's rows", () => {
  it("keeps the spawn's one line and drops what the subagent said and did", () => {
    const child = { agentId: 'task-1', producerKind: 'agent' as const }
    const folded = fold([
      user('ask', 'review the PR'),
      {
        id: 'spawn',
        role: 'system',
        blocks: [{ type: 'text', text: 'Kicked off 1 subagent' }],
        timestamp: 0,
        source: 'transcript'
      },
      { ...assistant('child-said', 'The PR is CLEAN.'), ...child },
      {
        id: 'child-grep',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Grep', input: {} }],
        timestamp: 0,
        source: 'transcript',
        ...child
      },
      assistant('answer', 'Delegated; nothing to fix.')
    ])

    expect(folded.map((message) => message.id)).toEqual(['ask', 'spawn', 'answer'])
    expect(folded[2]?.blocks).toEqual([{ type: 'text', text: 'Delegated; nothing to fix.' }])
  })
})
