import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'
import { prepareJsonlTranscriptImport } from './journal-jsonl-import'
import { importClaudeTranscript } from './journal-claude-import'
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

it('keeps active ancestors physically before a covered frontier', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-covered-frontier-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    '{"type":"assistant","uuid":"saved","parentUuid":null}\n' +
      '{"type":"user","uuid":"ancestor","parentUuid":"saved"}\n' +
      '{"type":"progress","uuid":"frontier","parentUuid":"saved"}\n' +
      '{"type":"assistant","uuid":"newest","parentUuid":"ancestor"}\n'
  )
  const tail = await readClaudeTranscriptTail({
    filePath,
    leafUuid: 'saved',
    chainBoundaries: ['frontier', 'saved'],
    check: () => {}
  })
  expect(tail?.rows.map((row) => row.uuid)).toEqual(['ancestor', 'newest'])
  expect(tail?.rewound).toBe(false)
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

it('keeps the same suffix for 60k tiny messages', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-60k-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    Array.from({ length: 60_000 }, (_, index) =>
      JSON.stringify({ type: 'assistant', uuid: `m-${index}`, parentUuid: index ? `m-${index - 1}` : null, message: { content: 'x' } })
    ).join('\n') + '\n'
  )
  const input = { agent: 'claude' as const, filePath, sessionId: '60k', limits: { inlineHeadBytes: 1024 }, retainedBytes: 2400 }
  const [forward, recovery] = await Promise.all([importClaudeTranscript(input), importClaudeTranscript({ ...input, bounded: true })])
  expect(recovery.items.map((item) => item.identity)).toEqual(forward.items.map((item) => item.identity))
})

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
  'keeps both messages after 20k trailing progress rows: %s',
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
    for (let index = 0; index < 20_000; index++) {
      const uuid = `progress-${index.toString().padStart(64, '0')}`
      await appendFile(
        filePath,
        `${JSON.stringify({ type: 'progress', uuid, parentUuid })}\n`
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

it.each(importModes)(
  'keeps an active progress bridge among unrelated links: %s',
  async (bounded) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-bridge-'))
    const filePath = join(root, 'session.jsonl')
    const unrelated = Array.from({ length: 12_000 }, (_, index) =>
      JSON.stringify({
        type: 'progress',
        uuid: `progress-${index}`,
        parentUuid: 'unrelated-parent-0000-0000-000000000000'
      })
    )
    await writeFile(
      filePath,
      [
        '{"type":"user","uuid":"ancestor","parentUuid":null,"message":{"content":"Question"}}',
        '{"type":"progress","uuid":"bridge","parentUuid":"ancestor"}',
        ...unrelated,
        '{"type":"assistant","uuid":"newest","parentUuid":"bridge","message":{"content":"Answer"}}',
        ''
      ].join('\n')
    )
    const imported = await importClaudeTranscript({
      agent: 'claude',
      filePath,
      sessionId: 'bridge-session',
      limits: { inlineHeadBytes: 1024 },
      retainedBytes: 2400,
      bounded
    })
    expect(imported.items.map(({ body }) => body)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
    ])
  }
)

it.each(importModes)('budgets active answers before abandoned answers: %s', async (bounded) => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-active-budget-'))
  const filePath = join(root, 'session.jsonl')
  const message = (uuid: string, parentUuid: string | null) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid,
      message: { content: uuid + 'x'.repeat(800) }
    })
  await writeFile(
    filePath,
    [
      message('selected', null),
      message('abandoned-1', 'selected'),
      message('abandoned-2', 'abandoned-1'),
      message('newest', 'selected'),
      ''
    ].join('\n')
  )
  const imported = await importClaudeTranscript({
    agent: 'claude',
    filePath,
    sessionId: 'active-budget-session',
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 2400,
    bounded
  })
  expect(imported.items.map(({ identity }) => identity)).toEqual([
    { provider: 'claude', sessionId: 'active-budget-session', uuid: 'selected' },
    { provider: 'claude', sessionId: 'active-budget-session', uuid: 'newest' }
  ])
})

it.each(importModes)(
  'keeps the newest conversation without a link ceiling: %s',
  async (bounded) => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-index-capacity-'))
    const filePath = join(root, 'session.jsonl')
    const noise = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ type: 'progress', uuid: `unrelated-${index}` })
    )
    await writeFile(
      filePath,
      [
        '{"type":"user","uuid":"old","message":{"content":"Old question"}}',
        ...noise,
        '{"type":"user","uuid":"question","parentUuid":"old","message":{"content":"New question"}}',
        '{"type":"assistant","uuid":"answer","parentUuid":"question","message":{"content":"New answer"}}',
        '{"type":"progress","uuid":"frontier","parentUuid":"answer"}',
        ''
      ].join('\n')
    )
    const input = {
      agent: 'claude' as const,
      filePath,
      sessionId: 'index-capacity-session',
      limits: { inlineHeadBytes: 1024 },
      retainedBytes: 2400,
      bounded
    }
    const imported = await importClaudeTranscript(input)
    expect(imported.items.map(({ body }) => body)).toEqual([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'New question' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'New answer' }] }
    ])
    expect(imported.sourceFrontier).toBe('frontier')
    if (bounded) {
      expect(imported.sourceMtimeMs).toEqual(expect.any(Number))
    }
  }
)

it('preserves the requested agent and absolute line index for UUID-less legacy messages', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-identity-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    Buffer.concat([
      Buffer.from('{"type":"progress"}\r\n'),
      Buffer.from([0xff, 0x0a]),
      Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"Saved answer"}}')
    ])
  )
  const imported = await prepareLegacyTranscriptImport({
    agent: 'openclaude',
    sessionId: 'legacy-session',
    options: { filePath }
  })
  expect(imported.ok && imported.items.map((item) => item.identity)).toEqual([
    { provider: 'legacy', agent: 'openclaude', sessionId: 'legacy-session', recordId: '#2' }
  ])

  await appendFile(filePath, '\n{"type":"user","uuid":"prompt","message":{"content":"Question"}}\n')
  const adopted = await prepareLegacyTranscriptImport({
    agent: 'openclaude',
    sessionId: 'legacy-session',
    options: { filePath, decodedMessageIdentities: true }
  })
  expect(adopted.ok && adopted.items.at(-1)?.identity).toEqual({
    provider: 'legacy',
    agent: 'openclaude',
    sessionId: 'legacy-session',
    recordId: 'prompt'
  })
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
