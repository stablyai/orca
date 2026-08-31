import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTextBlock, type NativeChatMessage } from '../../shared/native-chat-types'
import { readNativeChatTranscript } from './transcript-reader'
import { readIncrementalTranscriptMessages } from './transcript-incremental-reader'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

async function writeFixture(prefix: string, records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, jsonLines(records))
  return filePath
}

describe('readNativeChatTranscript (claude)', () => {
  it('renders a queued prompt once at its transcript position', async () => {
    const filePath = await writeFixture('orca-native-chat-queued-', [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'user', content: 'first prompt' }
      },
      {
        type: 'assistant',
        uuid: 'z-predecessor',
        timestamp: '2026-06-01T10:00:10.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] }
      },
      {
        type: 'attachment',
        uuid: 'a-queued',
        timestamp: '2026-06-01T10:00:05.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: 'queued prompt',
          timestamp: '2026-06-01T10:00:05.000Z'
        }
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-06-01T10:00:20.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final reply' }] }
      }
    ])

    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    expect('messages' in result).toBe(true)
    if (!('messages' in result)) {
      return
    }
    const assemblerUrl = new URL(
      '../../renderer/src/components/native-chat/native-chat-session-assembler.ts',
      import.meta.url
    ).href
    const assembler = (await import(/* @vite-ignore */ assemblerUrl)) as {
      assembleNativeChatSession: (input: {
        sources: { transcript: NativeChatMessage[] }
        sessionId: string
        agent: 'claude'
      }) => { messages: NativeChatMessage[] }
    }
    const session = assembler.assembleNativeChatSession({
      sources: { transcript: result.messages },
      sessionId: 'sess',
      agent: 'claude'
    })
    const visibleText = session.messages.flatMap((message) =>
      message.blocks.filter(isTextBlock).map((block) => block.text)
    )

    expect(visibleText).toEqual(['first prompt', 'first reply', 'queued prompt', 'final reply'])
    expect(visibleText.filter((text) => text === 'queued prompt')).toHaveLength(1)
  })

  it('decodes OpenClaude with the Claude transcript format', async () => {
    const filePath = await writeFixture('orca-native-chat-openclaude-', [
      {
        type: 'assistant',
        uuid: 'openclaude-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
      }
    ])

    await expect(
      readNativeChatTranscript('openclaude', 'session', { filePath })
    ).resolves.toMatchObject({ messages: [{ id: 'openclaude-assistant' }] })
  })

  it('does not let a hidden queued row consume a legacy tail-window slot', async () => {
    const filePath = await writeFixture('orca-native-chat-legacy-window-', [
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }
      },
      {
        type: 'assistant',
        uuid: 'a2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] }
      },
      {
        type: 'attachment',
        uuid: 'queued',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued' }
      },
      {
        type: 'assistant',
        uuid: 'a3',
        message: { role: 'assistant', content: [{ type: 'text', text: 'three' }] }
      }
    ])

    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'sess',
      filePath,
      limit: 2,
      includeQueuedPrompts: false
    })

    expect(result).toMatchObject({ messages: [{ id: 'a2' }, { id: 'a3' }], hasMore: true })
  })

  it('does not let a hidden queued row consume an incremental batch slot', async () => {
    const records: unknown[] = Array.from({ length: 39 }, (_unused, index) => ({
      type: 'assistant',
      uuid: `a-${index}`,
      message: { role: 'assistant', content: [{ type: 'text', text: `${index}` }] }
    }))
    records.push(
      {
        type: 'attachment',
        uuid: 'queued',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued' }
      },
      ...[39, 40, 41].map((index) => ({
        type: 'assistant',
        uuid: `a-${index}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `${index}` }] }
      }))
    )
    const filePath = await writeFixture('orca-native-chat-legacy-batch-', records)
    const decode = nativeChatLineDecoderForAgent('claude', false)
    expect(decode).not.toBeNull()
    if (!decode) {
      return
    }
    const batches: NativeChatMessage[][] = []
    const remaining = await readIncrementalTranscriptMessages(
      filePath,
      {
        offset: 0,
        pendingChunks: [],
        pendingStart: 0,
        pendingBytes: 0,
        droppingOversizedRecord: false
      },
      decode,
      (messages) => batches.push(messages)
    )

    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(40)
    expect(remaining).toHaveLength(1)
    expect([...batches[0]!, ...remaining].some((message) => message.queued)).toBe(false)
  })

  it('returns ordered user/assistant/tool messages with no 5-message cap', async () => {
    const records: unknown[] = []
    // 4 user/assistant turns = 8 messages, well past the AI-Vault preview cap.
    for (let turn = 0; turn < 4; turn++) {
      records.push({
        type: 'user',
        uuid: `u-${turn}`,
        timestamp: `2026-06-01T10:0${turn}:00.000Z`,
        message: { role: 'user', content: `Prompt **${turn}**` }
      })
      records.push({
        type: 'assistant',
        uuid: `a-${turn}`,
        timestamp: `2026-06-01T10:0${turn}:30.000Z`,
        message: { role: 'assistant', content: [{ type: 'text', text: `Reply _${turn}_` }] }
      })
    }
    // A tool_use then a tool_result (carried on a user record).
    records.push({
      type: 'assistant',
      uuid: 'a-tool',
      timestamp: '2026-06-01T10:05:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
      }
    })
    records.push({
      type: 'user',
      uuid: 'u-toolresult',
      timestamp: '2026-06-01T10:05:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'file-a\nfile-b', is_error: false }]
      }
    })

    const filePath = await writeFixture('orca-native-chat-claude-', records)
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    expect('messages' in result).toBe(true)
    if (!('messages' in result)) {
      return
    }

    expect(result.messages.length).toBe(10)
    expect(result.messages.length).toBeGreaterThan(5)
    expect(result.messages[0]).toMatchObject({ role: 'user', source: 'transcript' })
    // Markdown text preserved verbatim.
    expect(result.messages[0].blocks[0]).toEqual({ type: 'text', text: 'Prompt **0**' })
    expect(result.messages[1].blocks[0]).toEqual({ type: 'text', text: 'Reply _0_' })

    const toolCall = result.messages.find((m) => m.blocks[0]?.type === 'tool-call')
    expect(toolCall?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'Bash',
      input: { command: 'ls' }
    })

    const toolResult = result.messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(toolResult?.blocks[0]).toEqual({ type: 'tool-result', output: 'file-a\nfile-b' })
  })

  it('drops structurally marked injected user turns but keeps their tool results', async () => {
    const filePath = await writeFixture('orca-native-chat-claude-meta-', [
      {
        type: 'user',
        uuid: 'u-real',
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'user', content: 'fix the login bug' }
      },
      {
        type: 'user',
        uuid: 'u-meta',
        isMeta: true,
        timestamp: '2026-06-01T10:00:01.000Z',
        message: {
          role: 'user',
          content: 'Another Claude session sent a message:\n<agent-message from="reviewer">hi'
        }
      },
      {
        type: 'user',
        uuid: 'u-compact',
        isCompactSummary: true,
        timestamp: '2026-06-01T10:00:02.000Z',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation.'
        }
      },
      {
        type: 'user',
        uuid: 'u-meta-toolresult',
        isMeta: true,
        timestamp: '2026-06-01T10:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ok', is_error: false }]
        }
      },
      {
        type: 'user',
        uuid: 'u-meta-mixed',
        isMeta: true,
        timestamp: '2026-06-01T10:00:04.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>hidden machinery' },
            { type: 'tool_result', content: 'mixed result', is_error: false }
          ]
        }
      }
    ])
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }
    expect(result.messages.map((m) => m.id)).toEqual([
      'u-real',
      'u-meta-toolresult',
      'u-meta-mixed'
    ])
    expect(result.messages[1].role).toBe('tool')
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'mixed result' }]
    })
  })

  it('marks thinking-only assistant content as a reasoning surface', async () => {
    const filePath = await writeFixture('orca-native-chat-claude-think-', [
      {
        type: 'assistant',
        uuid: 'a-think',
        timestamp: '2026-06-01T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] }
      }
    ])
    const result = await readNativeChatTranscript('claude', 'sess', { filePath })
    if (!('messages' in result)) {
      throw new Error('expected messages')
    }
    expect(result.messages[0].blocks[0]).toEqual({ type: 'text', text: 'pondering' })
  })
})

describe('readNativeChatTranscript (codex)', () => {
  it('maps tool calls and results to tool-call/tool-result blocks', async () => {
    const filePath = await writeFixture('orca-native-chat-codex-', [
      {
        type: 'session_meta',
        timestamp: '2026-06-01T10:00:00.000Z',
        payload: { id: 'codex-sess', cwd: '/repo' }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Run the build' }]
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:02.000Z',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I will run it' }] }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:03.000Z',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"command":["bash","-lc","make"]}'
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:04.000Z',
        payload: {
          type: 'function_call_output',
          output: { content: 'build ok', success: true }
        }
      },
      {
        type: 'response_item',
        timestamp: '2026-06-01T10:00:05.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'codex-sess', { filePath })
    if (!('messages' in result)) {
      throw new Error(`expected messages, got error`)
    }

    const roles = result.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'reasoning', 'assistant', 'tool', 'assistant'])

    const call = result.messages.find((m) => m.blocks[0]?.type === 'tool-call')
    expect(call?.blocks[0]).toEqual({
      type: 'tool-call',
      name: 'shell',
      input: '{"command":["bash","-lc","make"]}'
    })

    const toolResult = result.messages.find((m) => m.blocks[0]?.type === 'tool-result')
    expect(toolResult?.blocks[0]).toEqual({ type: 'tool-result', output: 'build ok' })

    const reasoning = result.messages.find((m) => m.role === 'reasoning')
    expect(reasoning?.blocks[0]).toEqual({ type: 'text', text: 'I will run it' })
  })
})

describe('readNativeChatTranscript (errors)', () => {
  // Why: ENOENT after a successful resolve is the same first-flush/rotation
  // race as an unresolved path (#8401) — it must stay retry-worthy.
  it('marks an ENOENT on a directly-passed path as notFound (vanished after resolve)', async () => {
    const result = await readNativeChatTranscript('claude', 'sess', {
      filePath: join(tmpdir(), 'orca-native-chat-does-not-exist.jsonl')
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBe(true)
    }
  })

  it('returns a real read error (no notFound) when the path exists but is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unreadable-'))
    tempRoots.push(root)
    // A directory instead of a file fails the read with a non-ENOENT error.
    const result = await readNativeChatTranscript('claude', 'sess', { filePath: root })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBeUndefined()
    }
  })

  // Why: a just-created Claude Code session's transcript can take up to minutes
  // to exist on disk (#8401) — the miss must be marked retry-worthy so callers
  // above (cache, watch, renderer) don't settle into a permanent error.
  it('marks an unresolved session as notFound so callers know to retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-noresolve-'))
    tempRoots.push(root)
    const result = await readNativeChatTranscript('claude', 'missing', {
      claudeProjectsDir: join(root, 'empty')
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.notFound).toBe(true)
    }
  })
})

describe('readNativeChatTranscriptTailFile', () => {
  it('keeps a missing tail retry-worthy for the live-session seed', async () => {
    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 'sess',
      filePath: join(tmpdir(), 'orca-native-chat-tail-does-not-exist.jsonl'),
      limit: 40
    })

    expect(result).toMatchObject({ notFound: true })
  })

  it('windows to nothing for a non-positive limit instead of the whole tail', async () => {
    const decode = nativeChatLineDecoderForAgent('claude')!
    const filePath = await writeFixture('orca-native-chat-tail-limit-', [
      {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] }
      },
      {
        type: 'assistant',
        uuid: 'a-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] }
      }
    ])

    const result = await readNativeChatTranscriptTailFile(filePath, 0, decode, true)

    expect(result.messages).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})
