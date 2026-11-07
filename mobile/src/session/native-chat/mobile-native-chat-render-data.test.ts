import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
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
  it('places an idle send before the streaming reply it caused', () => {
    const data = build([assistant('a1', 'Earlier answer')], 'Starting the tests', [
      { id: 'p1', text: 'Run the tests', sentAt: 100 }
    ])
    expect(data.map((message) => message.id)).toEqual(['a1', 'p1', 'streaming'])
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

  it('keeps a queued follow-up after the current streaming reply', () => {
    const data = build([user('u1', 'hi')], 'thinking out loud', [
      { id: 'p1', text: 'queued', pendingSend: 'queued' }
    ])
    expect(data.map((message) => message.id)).toEqual(['u1', 'streaming', 'p1'])
    expect(data[1].blocks).toEqual([{ type: 'text', text: 'thinking out loud' }])
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

  it('leaves CI result lines out of the transcript', () => {
    const ciLine: NativeChatMessage = {
      id: 'orca:pr-event:github.com/acme/repo#3:8d5f74b:1',
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: 'CI failing on repo#3 at 8d5f74b',
          presentation: 'pull-request-event',
          tone: 'failure'
        }
      ],
      timestamp: 0,
      source: 'transcript'
    }
    const folded = fold([
      assistant('a1', 'Opened the PR'),
      ciLine,
      assistant('a2', 'Pushed the fix')
    ])
    expect(folded.map((message) => message.id)).toEqual(['a1', 'a2'])
    expect(JSON.stringify(folded)).not.toContain('CI failing on repo#3 at 8d5f74b')
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
