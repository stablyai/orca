import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeChatTextBlock } from './transcript-record-reader'
import { transcriptFallbackId } from './transcript-fallback-id'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writeClaudeRecords(
  records: unknown[]
): Promise<{ filePath: string; offsets: number[] }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-record-'))
  roots.push(root)
  const lines = records.map((record) => JSON.stringify(record))
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += Buffer.byteLength(line, 'utf8') + 1
  }
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, lines.join('\n'))
  return { filePath, offsets }
}

function assistantRecord(id: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }
}

describe('readNativeChatTextBlock', () => {
  it.each([
    ['ordinary prose', `Summary\n\n${'Readable paragraph. '.repeat(300).trimEnd()}`],
    ['fenced code', `\`\`\`ts\n${'const answer = 42\n'.repeat(300)}\`\`\``]
  ])('seeks directly to and returns complete %s', async (_label, fullText) => {
    const { filePath, offsets } = await writeClaudeRecords([
      assistantRecord('skip', 'small'),
      assistantRecord('target', fullText)
    ])

    await expect(
      readNativeChatTextBlock({
        agent: 'claude',
        sessionId: 'session',
        messageId: 'target',
        recordOffset: offsets[1]!,
        blockIndex: 0,
        filePath
      })
    ).resolves.toEqual({ text: fullText })
  })

  it('seeks past unrelated transcript history without decoding it', async () => {
    const fullText = 'target text '.repeat(500).trimEnd()
    const { filePath, offsets } = await writeClaudeRecords([
      assistantRecord('large-prefix', 'x'.repeat(4 * 1024 * 1024)),
      assistantRecord('target', fullText)
    ])

    await expect(
      readNativeChatTextBlock({
        agent: 'claude',
        sessionId: 'session',
        messageId: 'target',
        recordOffset: offsets[1]!,
        blockIndex: 0,
        filePath
      })
    ).resolves.toEqual({ text: fullText })
  })

  it('rejects a locator that does not match a record boundary or message id', async () => {
    const { filePath, offsets } = await writeClaudeRecords([assistantRecord('target', 'full')])
    const base = {
      agent: 'claude' as const,
      sessionId: 'session',
      messageId: 'target',
      blockIndex: 0,
      filePath
    }

    await expect(
      readNativeChatTextBlock({ ...base, recordOffset: offsets[0]! + 1 })
    ).resolves.toEqual({ error: 'Full message unavailable' })
    await expect(
      readNativeChatTextBlock({ ...base, messageId: 'other', recordOffset: offsets[0]! })
    ).resolves.toEqual({ error: 'Full message unavailable' })
  })

  it.each([
    {
      agent: 'codex' as const,
      record: (text: string) => ({
        type: 'event_msg',
        payload: { type: 'agent_message', id: 'codex-message', message: text }
      }),
      messageId: (_filePath: string) => 'codex-message'
    },
    {
      agent: 'grok' as const,
      record: (text: string) => ({
        type: 'assistant',
        id: 'grok-message',
        content: [{ type: 'text', text }]
      }),
      messageId: (filePath: string) => `${transcriptFallbackId(filePath, 0)}:grok-message`
    }
  ])('uses the $agent decoder without provider-specific retrieval behavior', async (fixture) => {
    const fullText = 'provider-neutral '.repeat(400).trimEnd()
    const { filePath } = await writeClaudeRecords([fixture.record(fullText)])

    await expect(
      readNativeChatTextBlock({
        agent: fixture.agent,
        sessionId: 'session',
        messageId: fixture.messageId(filePath),
        recordOffset: 0,
        blockIndex: 0,
        filePath
      })
    ).resolves.toEqual({ text: fullText })
  })
})
