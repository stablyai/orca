import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareJsonlTranscriptImport } from './journal-jsonl-import'
import {
  readClaudeTranscriptTail,
  readClaudeTranscriptWindow
} from '../../../claude/transcripts/claude-transcript-tail'

let root: string | undefined
const importModes: (true | undefined)[] = [undefined, true]

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(importModes)(
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

it.each(importModes)(
  'keeps parallel tool forks and drops rewound branches: %s',
  async (boundedClaude) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-tool-fork-'))
    const filePath = join(root, 'session.jsonl')
    const assistant = (uuid: string, parentUuid: string, id: string, tool: string) => ({
      type: 'assistant',
      uuid,
      parentUuid,
      sessionId: 'parallel-session',
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'tool_use', id: tool, name: 'Read', input: {} }]
      }
    })
    const result = (uuid: string, parentUuid: string, tool: string) => ({
      type: 'user',
      uuid,
      parentUuid,
      sessionId: 'parallel-session',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: tool, content: tool }]
      }
    })
    await writeFile(
      filePath,
      `${[
        { type: 'user', uuid: 'root', parentUuid: null, message: { content: 'Question' } },
        assistant('abandoned', 'root', 'old-message', 'old-tool'),
        result('abandoned-result', 'abandoned', 'old-tool'),
        assistant('A', 'root', 'shared-message', 'tool-1'),
        assistant('B', 'A', 'shared-message', 'tool-2'),
        result('C', 'B', 'tool-2'),
        result('D', 'A', 'tool-1')
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    )
    const imported = await prepareJsonlTranscriptImport({
      agent: 'claude',
      transcriptAgent: 'claude',
      sessionId: 'parallel-session',
      filePath,
      boundedClaude
    })
    expect(
      imported.ok &&
        imported.items.map(({ identity }) =>
          identity.provider === 'claude' ? identity.uuid : null
        )
    ).toEqual(['root', 'A', 'B', 'C', 'D'])
    const tail = await readClaudeTranscriptTail({ filePath, leafUuid: 'root', check: () => {} })
    expect(tail?.rows.map((row) => row.uuid)).toEqual(['A', 'B', 'C', 'D'])
  }
)

it.each(importModes)(
  'keeps conversation items beneath more than 20 MiB of progress: %s',
  async (boundedClaude) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-progress-'))
    const filePath = join(root, 'session.jsonl')
    await writeFile(
      filePath,
      `${[
        { type: 'user', uuid: 'question', parentUuid: null, message: { content: 'Question' } },
        {
          type: 'assistant',
          uuid: 'answer',
          parentUuid: 'question',
          message: { content: 'Answer' }
        }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    )
    let parentUuid = 'answer'
    for (let index = 0; index < 22; index++) {
      const uuid = `progress-${index}`
      await appendFile(
        filePath,
        `${JSON.stringify({ type: 'progress', uuid, parentUuid, data: 'x'.repeat(1024 * 1024) })}\n`
      )
      parentUuid = uuid
    }
    const imported = await prepareJsonlTranscriptImport({
      agent: 'claude',
      transcriptAgent: 'claude',
      sessionId: 'progress-session',
      filePath,
      boundedClaude
    })
    expect(imported.ok && imported.items.map((item) => item.body)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
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

it.each(importModes)(
  'excludes an unterminated record from the Claude source frontier: %s',
  async (boundedClaude) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-growing-'))
    const filePath = join(root, 'session.jsonl')
    await writeFile(
      filePath,
      '{"type":"assistant","uuid":"answer","message":{"role":"assistant","content":"Saved answer"}}\n' +
        '{"type":"progress","uuid":"still-writing","parentUuid":"answer"}'
    )
    const imported = await prepareJsonlTranscriptImport({
      agent: 'claude',
      transcriptAgent: 'claude',
      sessionId: 'claude-growing',
      filePath,
      boundedClaude
    })
    expect(imported).toMatchObject({ ok: true, sourceFrontier: 'answer' })
  }
)

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

it('counts a complete record over the per-record cap that the window passes over', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-window-'))
  const filePath = join(root, 'session.jsonl')
  const row = (uuid: string, text: string) =>
    `{"type":"assistant","uuid":"${uuid}","parentUuid":null,"message":{"content":"${text}"}}\n`
  const oversized = row('huge', 'x'.repeat(17 * 1024 * 1024))
  await writeFile(
    filePath,
    row('older', 'Older answer') + oversized + row('newest', 'Newest answer')
  )
  const window = await readClaudeTranscriptWindow({ filePath, check: () => {} })
  expect(window.skippedRecords).toBe(1)
  expect(window.rows.map((r) => r.uuid)).toEqual(['older', 'newest'])
})
