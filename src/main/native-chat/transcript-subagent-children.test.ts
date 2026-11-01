import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import { projectNativeChatTranscript } from '../../shared/native-chat/transcript/native-chat-transcript-projection'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
import {
  appendNativeChatChildTranscripts,
  windowNativeChatWithChildren
} from './transcript-subagent-children'
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
  it('keeps child rows when the parent window is shorter than the transcript', () => {
    const windowed = windowNativeChatWithChildren(
      [message('a'), message('b'), message('c'), message('child', '/root/sample_greeting')],
      2
    )
    expect(windowed.map((entry) => entry.id)).toEqual(['b', 'c', 'child'])
    expect(windowed[2]?.agentId).toBe('/root/sample_greeting')
  })

  it('leaves other agents on the parent transcript', async () => {
    const parent = [message('parent')]
    const loaded = await appendNativeChatChildTranscripts(
      '/missing',
      decodeGrokTranscriptLine,
      parent
    )
    expect(loaded).toEqual(parent)
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
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'child-assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Fixed and pushed' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git push' } }
          ]
        }
      })}\n`
    )
    await writeFile(join(childDir, 'agent-abc123.meta.json'), '{}\n')

    const loaded = await appendNativeChatChildTranscripts(
      parentPath,
      decodeClaudeTranscriptLine,
      []
    )
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.agentId).toBe('abc123')
    expect(loaded[0]?.id).toBe('abc123:child-assistant')
    expect(text(loaded[0]!)).toBe('Fixed and pushed')
    expect(toolNames(loaded[0]!)).toEqual(['Bash'])

    const live = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20
    })
    expect('messages' in live && live.messages.some((entry) => entry.agentId === 'abc123')).toBe(
      true
    )
    const paged = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'session',
      filePath: parentPath,
      limit: 20,
      beforeOffset: (await stat(parentPath)).size
    })
    expect('messages' in paged && paged.messages.some((entry) => entry.agentId)).toBe(false)
    expect('messages' in paged && paged.messages.length).toBeGreaterThan(0)
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
        payload: { type: 'function_call', id: 'fc-1', name: 'shell', call_id: 'call-1', arguments: '{}' }
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

    const loaded = await appendNativeChatChildTranscripts(parentPath, decodeCodexTranscriptLine, [
      message('parent')
    ])
    const greeting = loaded.filter((entry) => entry.agentId === '/root/sample_greeting')
    const checklist = loaded.filter((entry) => entry.agentId === '/root/sample_checklist')
    expect(greeting.flatMap(toolNames)).toEqual(['shell'])
    expect(greeting.map(text).join('\n')).toContain('Hello from Orca')
    expect(checklist.map(text).join('\n')).toContain('Checklist done')
    const projection = projectNativeChatTranscript(loaded)
    expect(projection.conversation.some((entry) => entry.agentId)).toBe(false)
    expect(
      projection.subagentRows
        .get('/root/sample_greeting')
        ?.some((row) => text(row.message).includes('Hello from Orca'))
    ).toBe(true)
  })

  it('delivers the child on the bounded snapshot the phone subscribes to', async () => {
    const root = await tempRoot()
    const parentPath = join(root, 'session.jsonl')
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: 'user', uuid: 'parent-user', message: { role: 'user', content: [{ type: 'text', text: 'parent' }] } })}\n`
    )
    await mkdir(join(root, 'session', 'subagents'), { recursive: true })
    await writeFile(
      join(root, 'session', 'subagents', 'agent-abc123.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'child-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed and pushed' }] }
      })}\n`
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
    const start = Date.now()
    while (snapshots.length === 0) {
      if (Date.now() - start > 2000) {
        subscription.unsubscribe()
        throw new Error('timed out waiting for the child snapshot')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    subscription.unsubscribe()
    expect(snapshots[0]?.some((entry) => entry.agentId === 'abc123' && text(entry).includes('Fixed and pushed'))).toBe(
      true
    )
  })

  it('skips a Codex child whose rollout file is gone', async () => {
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
    const loaded = await appendNativeChatChildTranscripts(parentPath, decodeCodexTranscriptLine, [
      message('parent')
    ])
    expect(loaded.map((entry) => entry.id)).toEqual(['parent'])
  })
})
