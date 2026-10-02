import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import { subscribeNativeChatTranscript } from './transcript-watch'
import { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
import { transcriptFallbackId } from './transcript-fallback-id'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-grok-updates-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function row(
  update: Record<string, unknown>,
  sessionId = 'child',
  method = 'session/update'
): string {
  return `${JSON.stringify({ timestamp: 1788814800, method, params: { sessionId, update } })}\n`
}
const textRow = (text: string, type = 'agent_message_chunk', sessionId = 'child'): string =>
  row({ sessionUpdate: type, content: { type: 'text', text } }, sessionId)
const texts = (messages: NativeChatMessage[]): string[] =>
  messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )

async function fixture(history: string, child = 'child'): Promise<string> {
  const path = join(root, 'cwd-group', child, 'updates.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, history)
  await writeFile(
    join(dirname(path), 'chat_history.jsonl'),
    `${JSON.stringify({ type: 'user', content: 'inherited parent context' })}\n`
  )
  return path
}

describe('Grok child presentation updates', () => {
  it('keeps only owning-session messages with byte-stable IDs through full reads and pagination', async () => {
    const hidden = textRow('grandchild text', 'agent_message_chunk', 'grandchild')
    const prompt = textRow('child task 🦋', 'user_message_chunk')
    const path = await fixture(hidden + prompt + textRow('child result'))
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual(['child task 🦋', 'child result'])
    expect(full.messages[0]?.id).toBe(transcriptFallbackId(path, Buffer.byteLength(hidden)))
    expect(full.messages[0]?.timestamp).toBe(1788814800000)
    const last = await readNativeChatTranscriptTail({
      agent: 'grok',
      sessionId: 'child',
      filePath: path,
      limit: 1
    })
    if ('error' in last) {
      throw new Error(last.error)
    }
    expect(texts(last.messages)).toEqual(['child result'])
    expect(last.hasMore).toBe(true)
    const previous = await readNativeChatTranscriptTail({
      agent: 'grok',
      sessionId: 'child',
      filePath: path,
      limit: 1,
      beforeOffset: last.beforeOffset
    })
    if ('error' in previous) {
      throw new Error(previous.error)
    }
    expect(texts(previous.messages)).toEqual(['child task 🦋'])
    expect(previous.hasMore).toBe(false)
  })

  it('ignores control notifications without guessing completion from their disk order', async () => {
    const path = await fixture(
      row(
        { sessionUpdate: 'response_completed', stop_reason: 'end_turn' },
        'child',
        '_x.ai/session/update'
      ) +
        textRow('pending final text flushed after completion') +
        row({ sessionUpdate: 'available_commands_update', availableCommands: [] }) +
        row({ sessionUpdate: 'usage_update', used: 100, size: 1000 })
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual(['pending final text flushed after completion'])
    expect(full.messages[0]?.assistantPhase).toBeUndefined()
  })

  it('preserves separately persisted metadata-bearing segments verbatim', async () => {
    const path = await fixture(
      row({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'First ' },
        _meta: { citation: 1 }
      }) +
        row({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'second.' },
          _meta: { citation: 2 }
        })
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual(['First ', 'second.'])
  })

  it('retains reasoning, tool identity, partial output and failed completion', async () => {
    const path = await fixture(
      textRow('thinking', 'agent_thought_chunk') +
        row({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Run sleep',
          name: 'bash',
          rawInput: { command: 'sleep 10' }
        }) +
        row({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: 'waiting' } }]
        }) +
        row({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'failed',
          rawOutput: 'cancelled'
        })
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(full.messages).toMatchObject([
      { role: 'reasoning', blocks: [{ type: 'text', text: 'thinking' }] },
      {
        role: 'assistant',
        blocks: [{ type: 'tool-call', callId: 't1', name: 'bash', state: 'running' }]
      },
      {
        role: 'tool',
        blocks: [{ type: 'tool-result', callId: 't1', output: 'waiting', isPartial: true }]
      },
      {
        role: 'tool',
        blocks: [{ type: 'tool-result', callId: 't1', output: 'cancelled', isError: true }]
      }
    ])
  })

  it('does not lose child work when Grok releases inherited context during compaction', async () => {
    const path = await fixture(textRow('child task', 'user_message_chunk') + textRow('child work'))
    await writeFile(
      join(dirname(path), 'summary.json'),
      JSON.stringify({ session_kind: 'subagent_fork', inherited_prefix_len: 100 })
    )
    await writeFile(
      join(dirname(path), 'chat_history.jsonl'),
      `${JSON.stringify({ type: 'assistant', content: 'compacted context, stale prefix length' })}\n`
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual(['child task', 'child work'])
  })

  it('preserves output supplied with the initial tool call and non-text tool content', async () => {
    const path = await fixture(
      row({
        sessionUpdate: 'tool_call',
        toolCallId: 'done',
        title: 'Read',
        status: 'completed',
        rawOutput: 'read result'
      }) +
        row({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit',
          status: 'completed',
          content: [{ type: 'diff', path: '/work/file', oldText: 'a', newText: 'b' }]
        })
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(full.messages[0]?.blocks).toMatchObject([
      { type: 'tool-call', state: 'completed' },
      { type: 'tool-result', output: 'read result' }
    ])
    expect(full.messages[1]?.blocks[0]).toMatchObject({
      type: 'tool-result',
      output: '[{"type":"diff","path":"/work/file","oldText":"a","newText":"b"}]'
    })
  })

  it('never falls back from missing updates to inherited chat_history', async () => {
    const path = await fixture('')
    await rm(path)
    const result = await readNativeChatTranscriptTail({
      agent: 'grok',
      sessionId: 'child',
      transcriptPath: path,
      grokSessionsDir: root,
      limit: 10
    })
    expect(result).toMatchObject({ notFound: true })
  })

  it('leaves ordinary Grok model-history rows unchanged', () => {
    expect(
      decodeGrokTranscriptLine(
        JSON.stringify({ type: 'assistant', content: 'ordinary answer' }),
        'legacy-id'
      )
    ).toMatchObject({ blocks: [{ type: 'text', text: 'ordinary answer' }] })
  })

  it('strips only enclosed fork/resume context from user updates, as Grok replay does', async () => {
    const path = await fixture(
      textRow(
        'before <fork-context>private parent history</fork-context>\n task <resume-context>private inherited summary</resume-context>\n after',
        'user_message_chunk'
      ) +
        textRow('<fork-context>assistant literal</fork-context>') +
        textRow('ordinary prompt <fork-context>without closing tag', 'user_message_chunk')
    )
    const full = await readNativeChatTranscript('grok', 'child', { filePath: path })
    if ('error' in full) {
      throw new Error(full.error)
    }
    expect(texts(full.messages)).toEqual([
      'before task after',
      '<fork-context>assistant literal</fork-context>',
      'ordinary prompt <fork-context>without closing tag'
    ])
  })

  it.each([undefined, 1])(
    'supports snapshots, nested isolation, appends and replacement with limit %s',
    async (initialLimit) => {
      const path = await fixture(textRow('child task', 'user_message_chunk'))
      const snapshots: string[][] = [],
        appends: string[] = [],
        replacements: string[][] = []
      const sub = await subscribeNativeChatTranscript({
        agent: 'grok',
        sessionId: 'child',
        filePath: path,
        initialLimit,
        onInitialSnapshot: (messages) => snapshots.push(texts(messages)),
        onAppend: (messages) => appends.push(...texts(messages)),
        onReplace: (messages) => replacements.push(texts(messages)),
        debounceMs: 1,
        reconciliationIntervalMs: 20
      })
      try {
        await expect.poll(() => snapshots).toEqual([['child task']])
        const live = textRow('live reply')
        await appendFile(path, live.slice(0, -2))
        await appendFile(path, live.slice(-2))
        await expect.poll(() => appends).toEqual(['live reply'])
        expect(replacements).toEqual([])
        await writeFile(`${path}.next`, textRow('resumed own history'))
        await rename(`${path}.next`, path)
        await expect.poll(() => replacements.at(-1)).toEqual(['resumed own history'])
        expect(appends).toEqual(['live reply'])
        const nested = await fixture(
          textRow('nested result', 'agent_message_chunk', 'grandchild'),
          'grandchild'
        )
        const full = await readNativeChatTranscript('grok', 'grandchild', { filePath: nested })
        if ('error' in full) {
          throw new Error(full.error)
        }
        expect(texts(full.messages)).toEqual(['nested result'])
      } finally {
        sub.unsubscribe()
      }
    }
  )
})
