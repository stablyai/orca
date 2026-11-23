import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'
import { prepareJsonlTranscriptImport } from './journal-jsonl-import'
import { importClaudeTranscript } from './journal-claude-import'
import './journal-claude-import-worker.test-fixture'
import { importClaudeTranscriptInWorker } from './journal-claude-import-worker'
import {
  readClaudeTranscriptFrontier,
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

it('keeps the same suffix as the plain newest window for 60k messages', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-60k-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    `${Array.from({ length: 60_000 }, (_, index) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `m-${index}`,
        parentUuid: index ? `m-${index - 1}` : null,
        message: { content: 'x'.repeat(400) }
      })
    ).join('\n')}\n`
  )
  const input = {
    agent: 'claude' as const,
    transcriptAgent: 'claude' as const,
    sessionId: '60k',
    filePath
  }
  const ids = (prepared: Awaited<ReturnType<typeof prepareJsonlTranscriptImport>>) =>
    prepared.ok ? prepared.items.map((item) => item.identity) : prepared.error
  // Refused scratch takes the plain newest-window decode, the one used before the spool.
  const [plain, forward, recovery] = await Promise.all([
    prepareJsonlTranscriptImport({ ...input, claudeScratch: { reserveBytes: Infinity } }),
    prepareJsonlTranscriptImport(input),
    prepareJsonlTranscriptImport({ ...input, boundedClaude: true })
  ])
  expect(ids(plain)).toHaveLength(29_641)
  expect(ids(forward)).toEqual(ids(plain))
  expect(ids(recovery)).toEqual(ids(plain))
})

it('falls back to the plain newest window when scratch fills during a first import', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-scratch-full-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    [
      '{"type":"user","uuid":"question","parentUuid":null,"message":{"content":"Question"}}',
      ...Array.from({ length: 4096 }, (_, index) =>
        JSON.stringify({ type: 'progress', uuid: `p-${index}`, parentUuid: 'question' })
      ),
      '{"type":"assistant","uuid":"answer","parentUuid":"question","message":{"content":"Answer"}}',
      ''
    ].join('\n')
  )
  const scratch = { parent: join(root, 'scratch'), quotaBytes: 128 * 1024 }
  const input = { agent: 'claude' as const, transcriptAgent: 'claude' as const, filePath }
  const first = await prepareJsonlTranscriptImport({
    ...input,
    sessionId: 'full',
    claudeScratch: scratch
  })
  expect(first.ok && first.items.map(({ body }) => body)).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
  ])
  const recovery = await prepareJsonlTranscriptImport({
    ...input,
    sessionId: 'full',
    boundedClaude: true,
    claudeScratch: scratch
  })
  expect(recovery).toMatchObject({ ok: false, error: 'Claude history import scratch is full.' })
  expect(await readdir(scratch.parent)).toEqual([])
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
      await appendFile(filePath, `${JSON.stringify({ type: 'progress', uuid, parentUuid })}\n`)
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

it.each(importModes)('keeps an ancestor 30k unrelated links back: %s', async (bounded) => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-distant-ancestor-'))
  const filePath = join(root, 'session.jsonl')
  const noise = Array.from({ length: 30_000 }, (_, index) =>
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
  const imported = await importClaudeTranscript({
    agent: 'claude' as const,
    filePath,
    sessionId: 'distant-ancestor-session',
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 2400,
    bounded
  })
  expect(imported.items.map(({ body }) => body)).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Old question' }] },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'New question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'New answer' }] }
  ])
  expect(imported.sourceFrontier).toBe('frontier')
  if (bounded) {
    expect(imported.sourceMtimeMs).toEqual(expect.any(Number))
  }
})

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

it('honours a cancel that arrives while the import waits for its turn', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-cancel-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(
    filePath,
    '{"type":"user","uuid":"q","parentUuid":null,"message":{"content":"Question"}}\n'
  )
  const controller = new AbortController()
  const imported = importClaudeTranscriptInWorker({
    agent: 'claude',
    filePath,
    sessionId: 'cancel-session',
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 2400,
    signal: controller.signal
  })
  controller.abort()
  await expect(imported).rejects.toThrow()
})

it('finds the same frontier in the window pass as the bounded probe a reopen repeats', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-frontier-'))
  const filePath = join(root, 'session.jsonl')
  const answer = '{"type":"assistant","uuid":"answer","message":{"content":"A"}}'
  const filler = '{"type":"file-history-snapshot","data":"xxxxxxxx"}'
  const cases = [
    `${answer}\n${filler}\n${filler}\n`,
    `${answer}\n${filler}\n${filler}\n{"type":"progress","uuid":"partial"}`,
    `${filler}\n${answer}\n{"torn\n${filler}\n`,
    `\n${answer}\n`
  ]
  for (const content of cases) {
    await writeFile(filePath, content)
    const size = Buffer.byteLength(content)
    for (let bound = 1; bound <= size + 1; bound += 1) {
      const window = await readClaudeTranscriptWindow({
        filePath,
        check: () => {},
        frontierBytes: bound,
        visit: () => false
      })
      const probe = await readClaudeTranscriptFrontier({
        filePath,
        consumedBytes: window.consumedBytes,
        maxBytes: bound,
        check: () => {}
      })
      expect([content, bound, window.frontier]).toEqual([content, bound, probe])
    }
  }
})
