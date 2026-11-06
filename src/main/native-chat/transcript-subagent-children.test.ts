import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { projectNativeChatTranscript } from '../../shared/native-chat/transcript/native-chat-transcript-projection'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../shared/mobile-bridge-frame-bytes'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { subscribeNativeChatTranscript } from './transcript-watch'

const THREAD_ID = '01a19597-ae9a-7a90-87a1-eedc6d3a4eba'
let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-child-transcript-'))
  roots.push(root)
  return root
}

function text(message: NativeChatMessage): string {
  return message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function toolNames(message: NativeChatMessage): string[] {
  return message.blocks.flatMap((block) => (block.type === 'tool-call' ? [block.name] : []))
}

function claudeLine(id: string, body: string, tool?: { name: string }): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: body },
        ...(tool
          ? [
              {
                type: 'tool_use',
                id: `${id}-tool`,
                name: tool.name,
                input: { command: 'git push' }
              }
            ]
          : [])
      ]
    }
  })}\n`
}

async function readMessages(
  args: Parameters<typeof readNativeChatTranscriptTail>[0]
): Promise<
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }
> {
  return readNativeChatTranscriptTail(args)
}

function message(id: string, agentId?: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript',
    ...(agentId ? { agentId } : {})
  }
}

describe('subagent child transcripts', () => {
  it('loads a Grok child history named by its session id under another cwd', async () => {
    const root = await tempRoot()
    const childId = '01a19910-aaaa-7aaa-8aaa-aaaaaaaaaaaa'
    const parentPath = join(
      root,
      'encoded-parent',
      '01a19910-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
      'chat_history.jsonl'
    )
    await mkdir(join(root, 'encoded-parent', '01a19910-bbbb-7bbb-8bbb-bbbbbbbbbbbb'), {
      recursive: true
    })
    await writeFile(parentPath, `${JSON.stringify({ type: 'user', content: 'parent' })}\n`)
    const childDir = join(root, 'encoded-child', childId)
    await mkdir(childDir, { recursive: true })
    await writeFile(
      join(childDir, 'chat_history.jsonl'),
      `${JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_query>Say hello from Grok</user_query>' }]
      })}\n${JSON.stringify({ type: 'assistant', content: 'Hello from the Grok subagent.' })}\n`
    )

    const loaded = await readMessages({
      agent: 'grok',
      sessionId: 'parent',
      filePath: parentPath,
      limit: 20,
      subagentId: childId
    })
    expect('messages' in loaded).toBe(true)
    if (!('messages' in loaded)) {
      return
    }
    const body = loaded.messages.map(text).join('\n')
    expect(body).toContain('Say hello from Grok')
    expect(body).toContain('Hello from the Grok subagent.')
    expect(loaded.messages.every((message) => message.agentId === childId)).toBe(true)
  })

  it('loads a Claude child file as that agent, including its tool call and final text', async () => {
    const root = await tempRoot()
    const parentPath = join(root, 'session.jsonl')
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: 'user', uuid: 'parent-user', message: { role: 'user', content: [{ type: 'text', text: 'parent' }] } })}\n`
    )
    const childDir = join(root, 'session', 'subagents')
    await mkdir(childDir, { recursive: true })
    await writeFile(
      join(childDir, 'agent-abc123.jsonl'),
      claudeLine('child-assistant', 'Fixed and pushed', { name: 'Bash' })
    )
    await writeFile(join(childDir, 'agent-abc123.meta.json'), '{}\n')

    const loaded = await readMessages({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      subagentId: 'abc123'
    })
    expect('messages' in loaded).toBe(true)
    if (!('messages' in loaded)) {
      return
    }
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0]?.agentId).toBe('abc123')
    expect(loaded.messages[0]?.id).toBe('abc123:child-assistant')
    expect(text(loaded.messages[0]!)).toBe('Fixed and pushed')
    expect(toolNames(loaded.messages[0]!)).toEqual(['Bash'])

    const live = await readMessages({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20
    })
    expect('messages' in live && live.messages.some((entry) => entry.agentId === 'abc123')).toBe(
      false
    )
    const paged = await readMessages({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      beforeOffset: (await stat(parentPath)).size
    })
    expect('messages' in paged && paged.messages.some((entry) => entry.agentId)).toBe(false)
    expect('messages' in paged && paged.messages.length).toBeGreaterThan(0)
    expect(decodeClaudeTranscriptLine).toBeTypeOf('function')
  })

  it('loads a Codex rollout linked by SubAgentActivity, including a sibling day', async () => {
    const root = await tempRoot()
    const day = join(root, '2026', '10', '31')
    const previous = join(root, '2026', '10', '30')
    await mkdir(day, { recursive: true })
    await mkdir(previous, { recursive: true })
    const parentPath = join(day, 'rollout-parent.jsonl')
    const threadId = THREAD_ID
    const siblingThread = '01a19597-bb61-7a43-840c-fb2cc644cbf9'
    await writeFile(
      parentPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            kind: 'completed',
            agent_thread_id: threadId,
            agent_path: '/root/sample_greeting'
          }
        }
      })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            kind: 'completed',
            agent_thread_id: siblingThread,
            agent_path: '/root/sample_checklist'
          }
        }
      })}\n`
    )
    await writeFile(
      join(day, `rollout-2026-10-31T00-00-00-${threadId}.jsonl`),
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-1',
          name: 'shell',
          call_id: 'call-1',
          arguments: '{}'
        }
      })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'msg-1',
            content: [{ type: 'output_text', text: 'Hello from Orca' }]
          }
        }
      })}\n`
    )
    await writeFile(
      join(previous, `rollout-2026-10-30T23-59-00-${siblingThread}.jsonl`),
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'msg-2',
            content: [{ type: 'output_text', text: 'Checklist done' }]
          }
        }
      })}\n`
    )

    const greeting = await readMessages({
      agent: 'codex',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      subagentId: '/root/sample_greeting'
    })
    const checklist = await readMessages({
      agent: 'codex',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      subagentId: '/root/sample_checklist'
    })
    expect('messages' in greeting).toBe(true)
    expect('messages' in checklist).toBe(true)
    if (!('messages' in greeting) || !('messages' in checklist)) {
      return
    }
    expect(greeting.messages.flatMap(toolNames)).toEqual(['shell'])
    expect(greeting.messages.map(text).join('\n')).toContain('Hello from Orca')
    const byThread = await readMessages({
      agent: 'codex',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      subagentId: threadId
    })
    expect('messages' in byThread && byThread.messages.map(text).join('\n')).toContain(
      'Hello from Orca'
    )
    expect(checklist.messages.map(text).join('\n')).toContain('Checklist done')
    const projection = projectNativeChatTranscript([message('parent'), ...greeting.messages])
    expect(projection.conversation.some((entry) => entry.agentId)).toBe(false)
    expect(
      projection.subagentRows
        .get('/root/sample_greeting')
        ?.some((row) => text(row.message).includes('Hello from Orca'))
    ).toBe(true)
    const parent = await readMessages({
      agent: 'codex',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20
    })
    expect('messages' in parent && parent.messages.some((entry) => entry.agentId)).toBe(false)
    expect(decodeCodexTranscriptLine).toBeTypeOf('function')
  })

  it('reports a missing Codex rollout instead of the parent row', async () => {
    const root = await tempRoot()
    const day = join(root, '2026', '10', '31')
    await mkdir(day, { recursive: true })
    const parentPath = join(day, 'rollout-parent.jsonl')
    await writeFile(
      parentPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            kind: 'completed',
            agent_thread_id: THREAD_ID,
            agent_path: '/root/sample_greeting'
          }
        }
      })}\n`
    )
    const loaded = await readMessages({
      agent: 'codex',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      subagentId: '/root/sample_greeting'
    })
    expect(loaded).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('opens a parent that has dozens of large children, then pages one child under the phone cap', async () => {
    const root = await tempRoot()
    const parentPath = join(root, 'session.jsonl')
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: 'user', uuid: 'parent-user', message: { role: 'user', content: [{ type: 'text', text: 'parent' }] } })}\n`
    )
    const childDir = join(root, 'session', 'subagents')
    await mkdir(childDir, { recursive: true })
    const padding = 'x'.repeat(20_000)
    await Promise.all(
      Array.from({ length: 42 }, (_, index) =>
        writeFile(
          join(childDir, `agent-child${index}.jsonl`),
          claudeLine(`child${index}`, `marker-${index} ${padding}`)
        )
      )
    )
    const parent = await readMessages({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 40
    })
    expect('messages' in parent).toBe(true)
    if (!('messages' in parent)) {
      return
    }
    expect(parent.messages.some((entry) => entry.agentId)).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(parent.messages))).toBeLessThan(
      MOBILE_BRIDGE_MAX_FRAME_BYTES
    )

    const snapshots: NativeChatMessage[][] = []
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      initialLimit: 40,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: () => {},
      debounceMs: 5,
      reconciliationIntervalMs: 20
    })
    try {
      await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 2000 })
    } finally {
      subscription.unsubscribe()
    }
    expect(snapshots[0]?.some((entry) => entry.agentId)).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(snapshots[0]))).toBeLessThan(
      MOBILE_BRIDGE_MAX_FRAME_BYTES
    )

    const child = await readMessages({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 40,
      subagentId: 'child7'
    })
    expect(
      'messages' in child && child.messages.some((entry) => text(entry).includes('marker-7'))
    ).toBe(true)
  })
})
