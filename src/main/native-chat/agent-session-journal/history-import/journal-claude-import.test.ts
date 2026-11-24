import { appendFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'
import { useImportScratch } from './journal-claude-import-worker.test-fixture'
import { importClaudeTranscriptInWorker } from './journal-claude-import-worker'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('imports only the newest main chain', async () => {
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
  const imported = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'chain-session',
    options: { filePath }
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
})

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
  const input = { agent: 'claude' as const, options: { filePath } }
  useImportScratch('raw', { reserveBytes: Infinity })
  const [plain, forward] = await Promise.all([
    prepareLegacyTranscriptImport({ ...input, sessionId: 'raw' }),
    prepareLegacyTranscriptImport({ ...input, sessionId: '60k' })
  ])
  const uuids = (prepared: Awaited<ReturnType<typeof prepareLegacyTranscriptImport>>) =>
    prepared.ok
      ? prepared.items.map(({ identity }) =>
          identity.provider === 'claude' ? identity.uuid : null
        )
      : prepared.error
  const expected = Array.from({ length: 29_641 }, (_, index) => `m-${30_359 + index}`)
  expect(uuids(plain)).toEqual(expected)
  expect(uuids(forward)).toEqual(expected)
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
  useImportScratch('full', scratch)
  const first = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'full',
    options: { filePath }
  })
  expect(first.ok && first.items.map(({ body }) => body)).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
  ])
  expect(await readdir(scratch.parent)).toEqual([])
})

it('keeps parallel tool forks and drops rewound branches', async () => {
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
  const imported = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'parallel-session',
    options: { filePath }
  })
  expect(
    imported.ok &&
      imported.items.map(({ identity }) => (identity.provider === 'claude' ? identity.uuid : null))
  ).toEqual(['root', 'A', 'B', 'C', 'D'])
})

it('keeps both messages after 20k trailing progress rows', async () => {
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
  const progress = Array.from({ length: 20_000 }, (_, index) => {
    const uuid = `progress-${index.toString().padStart(64, '0')}`
    const row = JSON.stringify({ type: 'progress', uuid, parentUuid })
    parentUuid = uuid
    return row
  })
  await appendFile(filePath, `${progress.join('\n')}\n`)
  const imported = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'progress-session',
    options: { filePath }
  })
  expect(imported.ok && imported.items.map((item) => item.body)).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
  ])
})

it('keeps an active progress bridge among unrelated links', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-bridge-'))
  const filePath = join(root, 'session.jsonl')
  const unrelated = Array.from({ length: 30_000 }, (_, index) =>
    JSON.stringify({
      type: 'progress',
      uuid: `progress-${String(index).padStart(64, '0')}`,
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
  const imported = await importClaudeTranscriptInWorker({
    agent: 'claude',
    filePath,
    sessionId: 'bridge-session',
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 2400
  })
  expect(imported.items.map(({ body }) => body)).toEqual([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Question' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }] }
  ])
})

it('budgets active answers before newer abandoned answers', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-active-budget-'))
  const filePath = join(root, 'session.jsonl')
  const message = (uuid: string, parentUuid: string | null, size = 800) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      parentUuid,
      message: { content: uuid + 'x'.repeat(size) }
    })
  await writeFile(
    filePath,
    [
      message('selected', null),
      message('abandoned', 'selected', 3600),
      message('newest', 'selected'),
      ''
    ].join('\n')
  )
  const imported = await importClaudeTranscriptInWorker({
    agent: 'claude',
    filePath,
    sessionId: 'active-budget-session',
    limits: { inlineHeadBytes: 1024 },
    retainedBytes: 2400
  })
  expect(imported.items.map(({ identity }) => identity)).toEqual([
    { provider: 'claude', sessionId: 'active-budget-session', uuid: 'selected' },
    { provider: 'claude', sessionId: 'active-budget-session', uuid: 'newest' }
  ])
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

it('honours a cancel before the worker starts', async () => {
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
  controller.abort(new Error('Import closed'))
  await expect(imported).rejects.toThrow('Import closed')
})
