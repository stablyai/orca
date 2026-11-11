import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { hasClaudeUsageResumeProjection } from './transcript-resume-projection'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import type { ClaudeUsageParseResumeState, ClaudeUsagePersistedFile } from './types'

type RowOptions = {
  input?: number
  output?: number
  read?: number
  write?: number
  write1h?: number
  route?: string
  session?: string
  timestamp?: string
  model?: string
}

let directory: string
let transcript: string

function row(key: string, options: RowOptions = {}): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: options.session ?? 'session',
    timestamp: options.timestamp ?? '2026-10-09T12:00:00.000Z',
    cwd: join(directory, options.route ?? 'first'),
    requestId: key,
    message: {
      id: key,
      model: options.model ?? 'model',
      usage: {
        input_tokens: options.input ?? 1,
        output_tokens: options.output ?? 2,
        cache_read_input_tokens: options.read ?? 0,
        cache_creation_input_tokens: options.write ?? 0,
        cache_creation: { ephemeral_1h_input_tokens: options.write1h ?? 0 }
      }
    }
  })}\n`
}

function checkpoint(file: ClaudeUsagePersistedFile): ClaudeUsageParseResumeState {
  if (!file.parseResumeState) {
    throw new Error('Expected a resumable fixture.')
  }
  return file.parseResumeState
}

async function project(
  previous?: ClaudeUsagePersistedFile,
  claimKey: (key: string) => boolean = () => true
): Promise<ClaudeUsagePersistedFile> {
  const resume =
    previous && hasClaudeUsageResumeProjection(previous) ? previous.parseResumeState : null
  const read = await readClaudeUsageScanFile(transcript, resume)
  if (previous) {
    expect(read.resumed).toBe(true)
  }
  return projectClaudeUsageScanFile(read, new Map(), claimKey, previous)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-tuple-append-'))
  transcript = join(directory, 'session.jsonl')
  await writeFile(transcript, `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n`)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('preserves first-row routing, encounter ties and deferred claims across successive appends', async () => {
  await appendFile(
    transcript,
    row('first', { input: 5, output: 1, route: 'first' }) +
      row('second', { input: 10, output: 1, route: 'second' }) +
      row('foreign', { input: 100, route: 'foreign', session: 'foreign' })
  )
  const claim = (key: string): boolean => key !== 'foreign:foreign'
  const initial = await project(undefined, claim)
  await appendFile(
    transcript,
    row('first', {
      input: 10,
      output: 0.5,
      route: 'changed',
      session: 'changed',
      model: 'changed',
      timestamp: '2026-10-10T12:00:00.000Z'
    }) + row('foreign', { input: 150, route: 'foreign', session: 'foreign' })
  )
  const changed = await project(initial, claim)
  const cold = await project(undefined, claim)
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(changed.hasDeferredClaims).toBe(true)
  expect(changed.sessions[0]?.locationBreakdown.map((entry) => entry.locationKey)).toEqual(
    checkpoint(initial).encounterOrder[0]?.projectKeys
  )
  const before = structuredClone(changed)
  await appendFile(transcript, row('second', { input: 20, route: 'changed' }))
  const latest = await project(changed, claim)
  expect(latest.sessions).toEqual((await project(undefined, claim)).sessions)
  expect(changed).toEqual(before)
  expect(latest.hasDeferredClaims).toBe(true)
  expect(latest.ownedDedupeKeys).toEqual(['first:first', 'second:second'])
})

it('attributes frozen source records without changing them or persisting their source-only fields', async () => {
  await appendFile(
    transcript,
    row('first', { input: 10, route: 'first' }) +
      row('second', { input: 20, route: 'second' }) +
      row('invalid', { timestamp: 'invalid' })
  )
  const read = await readClaudeUsageScanFile(transcript)
  const sourceBefore = structuredClone(read.turns)
  for (const turn of read.turns) {
    Object.freeze(turn)
  }
  Object.freeze(read.turns)
  const initial = await projectClaudeUsageScanFile(read, new Map(), () => true)
  expect(read.turns).toEqual(sourceBefore)
  expect(initial.sessions).toEqual((await project()).sessions)
  expect(JSON.stringify(initial)).not.toContain('"dedupeKey":')
  await appendFile(transcript, row('first', { input: 30 }) + row('new', { route: 'third' }))
  const appendRead = await readClaudeUsageScanFile(transcript, checkpoint(initial))
  const appendBefore = structuredClone(appendRead.turns)
  for (const turn of appendRead.turns) {
    Object.freeze(turn)
  }
  Object.freeze(appendRead.turns)
  const changed = await projectClaudeUsageScanFile(appendRead, new Map(), () => true, initial)
  const cold = await project()
  expect(appendRead.turns).toEqual(appendBefore)
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(JSON.stringify(changed)).not.toContain('"dedupeKey":')
})
