import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareJsonlTranscriptImport } from './journal-jsonl-import'
import { readClaudeTranscriptWindow } from '../../../claude/transcripts/claude-transcript-tail'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([undefined, true] as const)(
  'imports only the newest main chain, bounded recovery: %s',
  async (boundedClaude) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-chain-'))
    const filePath = join(root, 'session.jsonl')
    const message = (uuid: string, parentUuid: string | null, extra = {}) => ({
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId: 'chain-session',
      message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
      ...extra
    })
    await writeFile(
      filePath,
      `${[
        message('root', null),
        message('abandoned-answer', 'root'),
        message('selected-answer', 'root'),
        message('sidechain-answer', 'selected-answer', { isSidechain: true }),
        message('tool-sidechain-answer', 'selected-answer', { parent_tool_use_id: 'tool-1' })
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    )
    const imported = await prepareJsonlTranscriptImport({
      agent: 'claude',
      transcriptAgent: 'claude',
      sessionId: 'chain-session',
      filePath,
      boundedClaude
    })
    expect(
      imported.ok && imported.items.map((item) => ({ identity: item.identity, body: item.body }))
    ).toEqual([
      {
        identity: { provider: 'claude', sessionId: 'chain-session', uuid: 'root' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'root' }] }
      },
      {
        identity: { provider: 'claude', sessionId: 'chain-session', uuid: 'selected-answer' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'selected-answer' }]
        }
      }
    ])
  }
)

it('preserves absolute line identities for older messages without UUIDs on first import', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-identity-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    '{"type":"progress"}\n{"type":"progress"}\n{"type":"assistant","message":{"role":"assistant","content":"Saved answer"}}\n'
  )
  const imported = await prepareJsonlTranscriptImport({
    agent: 'claude',
    transcriptAgent: 'claude',
    sessionId: 'legacy-session',
    filePath
  })
  expect(imported.ok && imported.items.map((item) => item.identity)).toEqual([
    { provider: 'legacy', agent: 'claude', sessionId: 'legacy-session', recordId: '#2' }
  ])
})

it('reads and decodes a bounded recent window despite a large prefix', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-window-'))
  const filePath = join(root, 'session.jsonl')
  const prefix = `{"type":"progress","data":"${'x'.repeat(1024 * 1024)}"}\n`
  const newest =
    '{"type":"assistant","uuid":"newest","parentUuid":null,"message":{"content":"Newest answer"}}\n'
  await writeFile(filePath, prefix.repeat(30) + newest)
  const window = await readClaudeTranscriptWindow({ filePath, check: () => {} })
  expect(window.bytesRead).toBeLessThanOrEqual(20 * 1024 * 1024)
  expect(window.decodedBytes).toBeLessThanOrEqual(20 * 1024 * 1024)
  expect(window.sourceBytes).toBeGreaterThan(30 * 1024 * 1024)
  expect(window.rows.at(-1)).toMatchObject({
    uuid: 'newest',
    message: { content: 'Newest answer' }
  })
})
