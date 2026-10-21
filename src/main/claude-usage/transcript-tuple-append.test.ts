import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { hasClaudeUsageResumeProjection } from './transcript-resume-projection'
import { createClaudeUsageTokenCheckpoint } from './transcript-token-checkpoint'
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

it('copies checkpoint arrays while retaining every untouched historical tuple and route', async () => {
  const rows = Array.from({ length: 4_096 }, (_, index) =>
    row(`key-${index}`, {
      input: index === 0 ? -1 : index + 1,
      output: 2,
      read: (index % 4) / 4,
      write: (index % 3) / 2,
      write1h: (index % 3) / 4,
      route: `route-${index % 4}`
    })
  )
  await appendFile(transcript, `${rows.join('')}${row('invalid', { timestamp: 'invalid' })}`)
  const initial = await project()
  const before = structuredClone(initial)
  const initialState = checkpoint(initial)
  await appendFile(
    transcript,
    row('key-0', { input: -0.5, output: 3, read: 0.25, write: 0.5, write1h: 0.25 }) +
      row('key-1', { input: 1, output: 1 }) +
      row('invalid', { input: 50, timestamp: '2026-10-10T12:00:00.000Z' }) +
      row('new-shared', { route: 'route-0' }) +
      row('new-route', { route: 'last' })
  )
  const changed = await project(initial)
  const changedState = checkpoint(changed)
  const cold = await project()
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(changed.ownedDedupeKeys).toEqual(cold.ownedDedupeKeys)
  expect(changedState).toEqual(checkpoint(cold))
  expect(initial).toEqual(before)
  expect(changed.ownedDedupeKeys).not.toBe(initial.ownedDedupeKeys)
  expect(changedState.ownedTokenMaxima).not.toBe(initialState.ownedTokenMaxima)
  expect(changedState.projections).not.toBe(initialState.projections)
  expect(changedState.ownedTokenMaxima[0]).not.toBe(initialState.ownedTokenMaxima[0])
  for (let index = 1; index < 4_096; index++) {
    expect(changedState.ownedTokenMaxima[index]).toBe(initialState.ownedTokenMaxima[index])
  }
  expect(changedState.ownedTokenMaxima[4_096]).toEqual([50, 2, 0, 0, 0, null])
  for (const [index, projection] of initialState.projections.entries()) {
    expect(changedState.projections[index]).toBe(projection)
  }
  expect(changedState.projections).toHaveLength(initialState.projections.length + 1)
  expect(hasClaudeUsageResumeProjection(changed)).toBe(true)
})

it('indexes each retained route once instead of serializing its route for every historical key', async () => {
  await appendFile(
    transcript,
    Array.from({ length: 1_024 }, (_, index) =>
      row(`key-${index}`, { route: `route-${index % 2}` })
    ).join('')
  )
  const initial = await project()
  const stringify = vi.spyOn(JSON, 'stringify')
  const accumulator = createClaudeUsageTokenCheckpoint(initial)
  expect(stringify).toHaveBeenCalledTimes(checkpoint(initial).projections.length)
  expect(accumulator.find('key-100:key-100')).toBe(checkpoint(initial).ownedTokenMaxima[100])
  expect(
    accumulator.increase('key-100:key-100', {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0
    })
  ).toBeNull()
  expect(stringify).toHaveBeenCalledTimes(2)
  const encoded = accumulator.finish()
  expect(encoded.ownedTokenMaxima[100]).toBe(checkpoint(initial).ownedTokenMaxima[100])
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

it('keeps independent fractional maxima without clamping accepted signed token components', async () => {
  await appendFile(
    transcript,
    row('signed', { input: 5, output: -1, read: -0.5, write: -0.25, write1h: -0.5 }) +
      row('large', { input: 1e100 })
  )
  const initial = await project()
  expect(checkpoint(initial).ownedTokenMaxima[0]?.slice(0, 5)).toEqual([5, -1, -0.5, -0.25, -0.5])
  await appendFile(
    transcript,
    row('signed', { input: -0.5, output: 4, read: 0.25, write: 0, write1h: 0 }) +
      row('large', { input: 5e99, output: 3 })
  )
  const changed = await project(initial)
  const cold = await project()
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(checkpoint(changed)).toEqual(checkpoint(cold))
  expect(checkpoint(changed).ownedTokenMaxima[0]?.slice(0, 5)).toEqual([5, 4, 0.25, 0, 0])
  expect(checkpoint(changed).ownedTokenMaxima[1]?.slice(0, 5)).toEqual([1e100, 3, 0, 0, 0])
  expect(hasClaudeUsageResumeProjection(changed)).toBe(true)
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
