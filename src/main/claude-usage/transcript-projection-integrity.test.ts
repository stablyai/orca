import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readClaudeUsageScanFile } from './transcript-record-parser'
import { projectClaudeUsageScanFile } from './transcript-usage-projection'
import { hasClaudeUsageResumeProjection } from './transcript-resume-projection'
import type { ClaudeUsageParseResumeState, ClaudeUsagePersistedFile } from './types'

let directory: string
let transcript: string
let original: ClaudeUsagePersistedFile

function row(
  key: string,
  input: number,
  secondRoute = false,
  output = 2,
  sameSession = false
): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: secondRoute && !sameSession ? 'second' : 'first',
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd: join(directory, secondRoute ? 'second' : 'first'),
    requestId: key,
    message: {
      id: key,
      model: secondRoute ? 'model-b' : 'model-a',
      usage: { input_tokens: input, output_tokens: output }
    }
  })}\n`
}

function checkpoint(file: ClaudeUsagePersistedFile): ClaudeUsageParseResumeState {
  if (!file.parseResumeState) {
    throw new Error('Expected a resumable fixture.')
  }
  return file.parseResumeState
}

async function project(previous?: ClaudeUsagePersistedFile): Promise<ClaudeUsagePersistedFile> {
  const resume =
    previous && hasClaudeUsageResumeProjection(previous) ? previous.parseResumeState : null
  return projectClaudeUsageScanFile(
    await readClaudeUsageScanFile(transcript, resume),
    new Map(),
    () => true,
    previous
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-integrity-'))
  transcript = join(directory, 'session.jsonl')
  await writeFile(
    transcript,
    `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n${row('a', 100)}${row('b', 20, true)}${row('c', 10, true, 2, true)}`
  )
  original = await project()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.each([
  'lowerMaximum',
  'higherMaximum',
  'negativeMaximum',
  'keyOrder',
  'rowOrder',
  'routeIndex',
  'routeMetadata',
  'sessionOrder',
  'locationOrder',
  'sessionTotal',
  'locationTotal',
  'dailyTotal',
  'deferredFlag',
  'byteOffset',
  'lineCount',
  'boundaryDigest',
  'path',
  'missingDigest'
] as const)('cold-parses a persisted checkpoint with coupled %s corruption', async (mutation) => {
  const cached: ClaudeUsagePersistedFile = JSON.parse(JSON.stringify(original))
  const state = checkpoint(cached)
  const first = state.ownedTokenMaxima[0]
  const second = state.ownedTokenMaxima[1]
  const route = state.projections[0]
  const session = cached.sessions[0]
  const location = session?.locationBreakdown[0]
  const daily = cached.dailyAggregates[0]
  const order = state.encounterOrder[0]
  const key = cached.ownedDedupeKeys[0]
  const secondKey = cached.ownedDedupeKeys[1]
  if (
    !first ||
    !second ||
    !route ||
    !session ||
    !location ||
    !daily ||
    !order ||
    !key ||
    !secondKey
  ) {
    throw new Error('Expected two distinct routes in the checkpoint fixture.')
  }
  switch (mutation) {
    case 'lowerMaximum':
      first[0]--
      break
    case 'higherMaximum':
      first[0]++
      break
    case 'negativeMaximum':
      first[0] = -1
      break
    case 'keyOrder':
      cached.ownedDedupeKeys[0] = secondKey
      cached.ownedDedupeKeys[1] = key
      break
    case 'rowOrder':
      state.ownedTokenMaxima[0] = second
      state.ownedTokenMaxima[1] = first
      break
    case 'routeIndex':
      {
        const firstIndex = first[5]
        first[5] = second[5]
        second[5] = firstIndex
      }
      break
    case 'routeMetadata':
      state.projections.reverse()
      break
    case 'sessionOrder':
      state.encounterOrder.reverse()
      break
    case 'locationOrder':
      order.projectKeys.reverse()
      break
    case 'sessionTotal':
      session.totalInputTokens++
      break
    case 'locationTotal':
      location.inputTokens++
      break
    case 'dailyTotal':
      daily.inputTokens++
      break
    case 'deferredFlag':
      cached.hasDeferredClaims = !cached.hasDeferredClaims
      break
    case 'byteOffset':
      state.parsedBytes--
      break
    case 'lineCount':
      state.lineCount--
      break
    case 'boundaryDigest':
      state.boundaryDigest = 'changed'
      break
    case 'path':
      cached.path = join(directory, 'different-session.jsonl')
      break
    case 'missingDigest':
      delete state.projectionIntegrity
      break
  }
  expect(hasClaudeUsageResumeProjection(cached)).toBe(false)
  await appendFile(transcript, row('a', 150))
  const changed = await project(cached)
  const cold = await project()
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(changed.ownedDedupeKeys).toEqual(cold.ownedDedupeKeys)
})

it('preserves accepted negative token components through persistence and an independent maximum update', async () => {
  await writeFile(
    transcript,
    `${JSON.stringify({ type: 'user', text: 'x'.repeat(20_000) })}\n${row('negative', -1)}`
  )
  const initial = await project()
  const cached: ClaudeUsagePersistedFile = JSON.parse(JSON.stringify(initial))
  expect(hasClaudeUsageResumeProjection(cached)).toBe(true)
  expect(checkpoint(cached).ownedTokenMaxima[0]?.[0]).toBe(-1)
  await appendFile(transcript, row('negative', 0, false, 3))
  const changed = await project(cached)
  const cold = await project()
  expect(changed.sessions).toEqual(cold.sessions)
  expect(changed.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(changed.sessions[0]?.turnCount).toBe(1)
})
