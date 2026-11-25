import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importClaudeTranscript, type ClaudeImportInput } from './journal-claude-import'
import { ClaudeImportSource, type ClaudeRange } from './journal-claude-import-source'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

let root: string | undefined
const utf8 = (item: Buffer): JournalReplacementItem => JSON.parse(item.toString('utf8'))
const entry = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  sessionId: 'session',
  timestamp: '2026-11-01T00:00:00.000Z',
  message: { content: uuid },
  ...extra
})
const boundary = (compactMetadata: unknown) => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid: 'boundary',
  parentUuid: null,
  logicalParentUuid: 'old',
  compactMetadata
})

async function transcript(rows: unknown[]): Promise<ClaudeImportInput> {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-import-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
  return {
    filePath,
    sessionId: 'session',
    agent: 'claude',
    retainedBytes: 16 * 1024 * 1024,
    limits: { inlineHeadBytes: 16 * 1024 }
  }
}

async function items(input: ClaudeImportInput) {
  const result = await importClaudeTranscript(input)
  try {
    await result.verify()
    return result.items.map(utf8)
  } finally {
    await result.close()
  }
}

const identities = (items: JournalReplacementItem[]) =>
  items.map(({ identity }) =>
    identity.provider === 'claude'
      ? identity.uuid
      : identity.provider === 'legacy'
        ? identity.recordId
        : identity.provider
  )

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('uses the later physical leaf on ties, and follows late system markers through progress', async () => {
  const root = entry('root', null)
  const left = entry('left', 'root')
  const right = entry('right', 'root')
  const progress = { type: 'progress', uuid: 'bridge', parentUuid: 'left' }
  const input = await transcript([
    root,
    left,
    right,
    progress,
    { type: 'attachment', uuid: 'brief', parentUuid: 'left', attachment: { type: 'fork_briefing' } }
  ])
  expect(identities(await items(input))).toEqual(['root', 'right'])
  await appendFile(
    input.filePath,
    `${JSON.stringify({
      type: 'system',
      uuid: 'marker',
      parentUuid: 'bridge'
    })}\n`
  )
  expect(identities(await items(input))).toEqual(['root', 'left'])
})

it('keeps progress links amid huge skipped objects and trailing progress rows', async () => {
  const input = await transcript([
    entry('root', null),
    {
      type: 'attachment',
      uuid: 'attachment',
      parentUuid: 'root',
      attachment: { type: 'prompt_snapshot', payload: '🚀'.repeat(1_200_000) }
    },
    {
      type: 'progress',
      uuid: 'bridge',
      parentUuid: 'attachment',
      data: { payload: 'x'.repeat(4_000_000) }
    },
    entry('answer', 'bridge'),
    entry('abandoned', 'root'),
    { type: 'system', uuid: 'marker', parentUuid: 'answer' },
    ...Array.from({ length: 20_000 }, (_, index) => ({
      type: 'progress',
      uuid: `progress-${index}`,
      parentUuid: index ? `progress-${index - 1}` : 'abandoned'
    }))
  ])
  expect(identities(await items(input))).toEqual(['root', 'answer'])
})

it('ends at a compact boundary when logicalParentUuid is the only old link', async () => {
  const input = await transcript([
    entry('old', null),
    boundary(undefined),
    entry('new', 'boundary')
  ])
  expect(identities(await items(input))).toEqual(['new'])
})

it('rewires preserved messages and skips an incomplete list', async () => {
  const head = [
    entry('old', null),
    entry('before', 'old'),
    entry('preserve-first', 'before'),
    entry('preserve-last', 'before')
  ]
  const input = await transcript([
    ...head,
    boundary({
      preservedMessages: { anchorUuid: 'boundary', uuids: ['preserve-first', 'preserve-last'] }
    }),
    entry('new', 'boundary')
  ])
  expect(identities(await items(input))).toEqual(['preserve-first', 'preserve-last', 'new'])
  await writeFile(
    input.filePath,
    [
      ...head,
      boundary({
        preservedMessages: { anchorUuid: 'boundary', uuids: ['preserve-first', 'missing'] }
      }),
      entry('new', 'boundary')
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('')
  )
  expect(identities(await items(input))).toEqual(['new'])
})

it('rewires a preserved segment after a large raw offset', async () => {
  const input = await transcript([
    entry('old', null),
    { type: 'progress', data: 'x'.repeat(6 * 1024 * 1024) },
    entry('head', 'old'),
    entry('tail', 'head'),
    boundary({ preservedSegment: { anchorUuid: 'boundary', headUuid: 'head', tailUuid: 'tail' } }),
    entry('new', 'boundary')
  ])
  expect(identities(await items(input))).toEqual(['head', 'tail', 'new'])
})

it('closes parallel tool calls with canonical UUIDs and unambiguous result ownership', async () => {
  const tool = (uuid: string, group: string, id: string) =>
    entry(uuid, 'root', {
      message: { id: group, content: [{ type: 'tool_use', name: 'Read', id, input: {} }] }
    })
  const result = (uuid: string, parentUuid: string, id: string, extra = {}) =>
    entry(uuid, parentUuid, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: uuid }] },
      ...extra
    })
  const input = await transcript([
    entry('root', null),
    tool('abandoned', 'other', 'shared'),
    tool('replacement', 'active', 'old-id'),
    tool('selected', 'active', 'shared'),
    tool('parallel', 'active', 'unique'),
    tool('replacement', 'active', 'new-id'),
    result('direct', 'selected', 'shared'),
    result('ambiguous', 'abandoned', 'shared', { sourceToolAssistantUUID: 'selected' }),
    result('cross-parent', 'abandoned', 'unique', { sourceToolAssistantUUID: 'parallel' }),
    result('duplicate-cross', 'abandoned', 'unique'),
    result('obsolete', 'abandoned', 'old-id'),
    result('subagent', 'selected', 'shared', { parent_tool_use_id: 'subagent-call' }),
    entry('answer', 'direct')
  ])
  const actual = await items(input)
  expect(identities(actual)).toEqual([
    'root',
    'selected',
    'parallel',
    'replacement',
    'direct',
    'cross-parent',
    'answer'
  ])
  expect(actual[3].body).toMatchObject({ kind: 'tool-call', callId: 'new-id' })
})

it('keeps the legacy line and decoded-offset identities across CRLF and malformed UTF-8', async () => {
  const input = await transcript([])
  const records = [
    Buffer.from(`${JSON.stringify(entry('root', null))}\r\n`),
    Buffer.from([0xc0, 0x0d, 0x0a]),
    Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: 'legacy' } })}\r\n`),
    Buffer.from(`${JSON.stringify(entry('lost', 'root'))}\r\n`),
    Buffer.from(
      `${JSON.stringify({ type: 'assistant', parentUuid: 'lost', message: { content: 'orphan' } })}\r\n`
    ),
    Buffer.from(`${JSON.stringify(entry('chosen', 'root'))}\r\n`)
  ]
  await writeFile(input.filePath, Buffer.concat(records))
  expect(identities(await items(input))).toEqual(['root', '#2', 'chosen'])
  const decoded = await items({ ...input, decodedMessageIdentities: true })
  expect(identities(decoded)).toEqual([
    'root',
    `${input.filePath}:${String(records[0].length + 5).padStart(16, '0')}`,
    'chosen'
  ])
})

it('keeps the same newest suffix as a linear 60k import', async () => {
  const input = await transcript(
    Array.from({ length: 60_000 }, (_, index) => ({
      type: 'assistant',
      uuid: `m-${index}`,
      parentUuid: index ? `m-${index - 1}` : null,
      message: { content: 'x'.repeat(400) }
    }))
  )
  const result = await items({ ...input, sessionId: '60k' })
  expect(identities(result)).toEqual(
    Array.from({ length: 29_641 }, (_, index) => `m-${30_359 + index}`)
  )
})

it('accepts verified appends but refuses an edit to a discarded link', async () => {
  const input = await transcript([entry('old', null), entry('lost', 'old'), entry('answer', 'old')])
  const result = await importClaudeTranscript(input)
  try {
    await appendFile(input.filePath, `${JSON.stringify(entry('append', 'answer'))}\n`)
    await result.verify()
    const file = [
      entry('old', null),
      entry('lost', 'xxx'),
      entry('answer', 'old'),
      entry('append', 'answer')
    ]
    await writeFile(input.filePath, file.map((row) => `${JSON.stringify(row)}\n`).join(''))
    await expect(result.verify()).rejects.toThrow(ClaudeImportResourceError)
  } finally {
    await result.close()
  }
})

it.each(['truncation', 'replacement'] as const)(
  'refuses %s of the snapshot before publication',
  async (change) => {
    const input = await transcript([entry('a', null)])
    const result = await importClaudeTranscript(input)
    try {
      if (change === 'truncation') {
        await truncate(input.filePath, 0)
      } else {
        await rename(input.filePath, `${input.filePath}.old`)
        await writeFile(input.filePath, `${JSON.stringify(entry('a', null))}\n`)
      }
      await expect(result.verify()).rejects.toThrow(ClaudeImportResourceError)
    } finally {
      await result.close()
    }
  }
)

it('refuses a rewritten selected row during the offset reread', async () => {
  const input = await transcript([entry('root', null)])
  const source = await ClaudeImportSource.open(input.filePath)
  try {
    const ranges: ClaudeRange[] = []
    await source.scan((_, range) => {
      ranges.push(range)
    })
    await writeFile(input.filePath, `${JSON.stringify(entry('edit', null))}\n`)
    await expect(source.reread(ranges).next()).rejects.toThrow(ClaudeImportResourceError)
  } finally {
    await source.close()
  }
})

it('validates adoption using the requested agent identity', async () => {
  const input = await transcript([entry('root', null)])
  const workspaceCwd = root!
  const source = { providerSessionId: 'session', workspaceCwd }
  await writeFile(input.filePath, JSON.stringify(entry('root', null, { cwd: workspaceCwd })))
  expect(identities(await items({ ...input, source }))).toEqual(['root'])
  await expect(items({ ...input, agent: 'openclaude', source })).rejects.toThrow(
    'The saved conversation does not match the requested provider identity.'
  )
})
