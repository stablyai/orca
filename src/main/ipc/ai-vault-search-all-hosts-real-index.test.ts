import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { SessionSearchInstance } from '../ai-vault-search/session-search-instance'
import {
  claudeLines,
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from '../ai-vault-search/session-search-indexer-test-fixture'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { searchAllExecutionHosts, type SessionSearchHostLeg } from './ai-vault-search-all-hosts'
import { encodeMergedSearchCursor } from './ai-vault-search-merged-cursor'

/**
 * Three real indexes over real transcripts, wired as three legs. Everything a
 * merged page claims — every hit exactly once, a purge fencing one host, an
 * unreachable host retried — is checked against the hit sets the indexes hold.
 */

const HOST_IDS = ['local', 'ssh:alpha', 'ssh:beta'] as const
const SESSIONS_PER_HOST = [14, 13, 13] as const

type Host = {
  executionHostId: ExecutionHostId
  harness: SessionSearchIndexerHarness
  instance: SessionSearchInstance
  sessionIds: string[]
}

let hosts: Host[]

function sessionIdFor(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, '0')}`
}

async function writeSession(harness: SessionSearchIndexerHarness, index: number): Promise<string> {
  const sessionId = sessionIdFor(index)
  const path = join(harness.claudeProjectDir, `${sessionId}.jsonl`)
  await mkdir(harness.claudeProjectDir, { recursive: true })
  // A distinct start index per session gives every hit in the fixture its own
  // `updatedAt`, so the newest-first order across hosts is total.
  const lines = claudeLines([`needle transcript ${index}`], sessionId, index * 2)
  await writeFile(path, `${lines.join('\n')}\n`)
  return sessionId
}

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  hosts = []
  let nextIndex = 0
  for (const [position, executionHostId] of HOST_IDS.entries()) {
    const harness = await openSessionSearchIndexerHarness(`ss-all-hosts-${position}`)
    const sessionIds: string[] = []
    for (let n = 0; n < SESSIONS_PER_HOST[position]!; n++) {
      sessionIds.push(await writeSession(harness, nextIndex++))
    }
    const instance = new SessionSearchInstance({
      databasePath: harness.databasePath,
      roots: harness.roots,
      onError: (error) => {
        throw error
      }
    })
    // One process holds one index, so the transcript reader publishes every read
    // to every live consumer. Three machines means three indexes built alone.
    instance.apply({ enabled: true, historyDays: null })
    await instance.settled()
    instance.close()
    hosts.push({ executionHostId, harness, instance, sessionIds })
  }
  for (const host of hosts) {
    host.instance.apply({ enabled: true, historyDays: null })
    await host.instance.settled()
    const own = resultsOf(await host.instance.search({ query: 'needle', limit: 100 }))
    expect(own.hits.map((hit) => hit.sessionId).sort()).toEqual([...host.sessionIds].sort())
  }
})

afterEach(async () => {
  for (const host of hosts) {
    host.instance.close()
    await host.harness.cleanup()
  }
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
})

function legs(overrides: Partial<Record<string, SessionSearchHostLeg['search']>> = {}) {
  return hosts.map((host) => ({
    executionHostId: host.executionHostId,
    search: overrides[host.executionHostId] ?? ((request) => host.instance.search(request))
  })) satisfies SessionSearchHostLeg[]
}

function resultsOf(response: AiVaultSearchResponse) {
  if (response.kind !== 'results') {
    throw new Error(`expected results, got ${response.kind}`)
  }
  return response
}

function keysOf(response: AiVaultSearchResponse): string[] {
  return resultsOf(response).hits.map((hit) => `${hit.executionHostId}/${hit.sessionId}`)
}

function everyKey(): string[] {
  return hosts.flatMap((host) =>
    host.sessionIds.map((sessionId) => `${host.executionHostId}/${sessionId}`)
  )
}

async function paginate(
  limit: number,
  sort: 'relevance' | 'newest',
  hostLegs = legs()
): Promise<{ keys: string[]; pages: number }> {
  const request = { query: 'needle', limit, filters: { sort } }
  const keys: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const response = resultsOf(
      await searchAllExecutionHosts(cursor === null ? request : { ...request, cursor }, hostLegs)
    )
    keys.push(...keysOf(response))
    cursor = response.page.cursor
    pages++
    expect(pages).toBeLessThan(40)
  } while (cursor !== null)
  return { keys, pages }
}

it('hands out every hit on every host exactly once, at limit 5 and limit 20', async () => {
  const expected = everyKey().sort()
  expect(expected).toHaveLength(40)
  for (const limit of [5, 20]) {
    for (const sort of ['relevance', 'newest'] as const) {
      const { keys } = await paginate(limit, sort)
      expect(new Set(keys).size, `${sort} at ${limit} repeated a hit`).toBe(keys.length)
      expect([...keys].sort(), `${sort} at ${limit} lost a hit`).toEqual(expected)
    }
  }
})

it('orders a newest merge by recency across hosts, newest first', async () => {
  const response = resultsOf(
    await searchAllExecutionHosts(
      { query: 'needle', limit: 20, filters: { sort: 'newest' } },
      legs()
    )
  )
  const updated = response.hits.map((hit) => hit.updatedAt)
  expect(updated).toEqual([...updated].sort().toReversed())
  // The 20 newest of the 40 are the 20 highest session indexes, which span hosts.
  expect(new Set(response.hits.map((hit) => hit.executionHostId)).size).toBeGreaterThan(1)
})

it('rotates hosts in host-id order when merging by relevance', async () => {
  const response = resultsOf(await searchAllExecutionHosts({ query: 'needle', limit: 6 }, legs()))
  expect(response.hits.map((hit) => hit.executionHostId)).toEqual([
    'local',
    'ssh:alpha',
    'ssh:beta',
    'local',
    'ssh:alpha',
    'ssh:beta'
  ])
})

it('fences the purged host and keeps the other two paginating', async () => {
  const request = { query: 'needle', limit: 5 }
  const first = resultsOf(await searchAllExecutionHosts(request, legs()))
  expect(first.hosts?.every((host) => host.outcome === 'searched')).toBe(true)

  // A real purge: the transcript is gone and a full reconcile publishes that.
  const purged = hosts[2]!
  await rm(join(purged.harness.claudeProjectDir, `${purged.sessionIds[0]!}.jsonl`))
  await purged.instance.reconcile()

  const second = resultsOf(
    await searchAllExecutionHosts({ ...request, cursor: first.page.cursor! }, legs())
  )
  expect(second.hosts).toContainEqual({
    executionHostId: 'ssh:beta',
    outcome: 'stale'
  })
  expect(second.hits.some((hit) => hit.executionHostId === 'ssh:beta')).toBe(false)

  const seen = [...keysOf(first), ...keysOf(second)]
  let cursor = second.page.cursor
  let pages = 0
  while (cursor !== null) {
    const page = resultsOf(await searchAllExecutionHosts({ ...request, cursor }, legs()))
    seen.push(...keysOf(page))
    cursor = page.page.cursor
    // A merge that never retires a host would page for ever; fail instead.
    expect((pages += 1)).toBeLessThan(40)
  }
  // Beta contributed only what it handed out before the purge; nothing repeats,
  // and both healthy hosts finished their own hit sets.
  expect(new Set(seen).size).toBe(seen.length)
  const betaEmitted = keysOf(first).filter((key) => key.startsWith('ssh:beta/'))
  expect([...seen].sort()).toEqual(
    [
      ...hosts[0]!.sessionIds.map((id) => `local/${id}`),
      ...hosts[1]!.sessionIds.map((id) => `ssh:alpha/${id}`),
      ...betaEmitted
    ].sort()
  )
})

it('reports an unreachable host, keeps hasMore, and picks it up on the retry', async () => {
  let reject = true
  const flaky = () =>
    reject
      ? Promise.reject(new Error('relay down'))
      : hosts[1]!.instance.search({
          query: 'needle',
          limit: 5,
          filters: { sort: 'relevance' }
        })
  const request = { query: 'needle', limit: 5 }
  const first = resultsOf(await searchAllExecutionHosts(request, legs({ 'ssh:alpha': flaky })))
  expect(first.hosts).toContainEqual({
    executionHostId: 'ssh:alpha',
    outcome: 'unreachable'
  })
  expect(first.page.hasMore).toBe(true)
  expect(first.hits.some((hit) => hit.executionHostId === 'ssh:alpha')).toBe(false)

  reject = false
  const second = resultsOf(
    await searchAllExecutionHosts({ ...request, cursor: first.page.cursor! }, legs())
  )
  expect(second.hosts).toContainEqual({
    executionHostId: 'ssh:alpha',
    outcome: 'searched'
  })
  expect(second.hits.some((hit) => hit.executionHostId === 'ssh:alpha')).toBe(true)

  const seen = [...keysOf(first), ...keysOf(second)]
  let cursor = second.page.cursor
  let pages = 0
  while (cursor !== null) {
    const page = resultsOf(await searchAllExecutionHosts({ ...request, cursor }, legs()))
    seen.push(...keysOf(page))
    cursor = page.page.cursor
    // A merge that never retires a host would page for ever; fail instead.
    expect((pages += 1)).toBeLessThan(40)
  }
  expect(new Set(seen).size).toBe(seen.length)
  expect([...seen].sort()).toEqual(everyKey().sort())
})

it('refuses a cursor whose page size or host set no longer matches the request', async () => {
  const first = resultsOf(await searchAllExecutionHosts({ query: 'needle', limit: 5 }, legs()))
  expect(
    await searchAllExecutionHosts(
      { query: 'needle', limit: 20, cursor: first.page.cursor! },
      legs()
    )
  ).toEqual({ kind: 'malformed-cursor' })
  const nonHost = encodeMergedSearchCursor({
    limit: 5,
    sort: 'relevance',
    hosts: { 'not-a-host': { c: null, e: 0, g: 0 } }
  })
  expect(
    await searchAllExecutionHosts({ query: 'needle', limit: 5, cursor: nonHost }, legs())
  ).toEqual({ kind: 'malformed-cursor' })
})

it('reports a disabled host without aborting the merge', async () => {
  hosts[2]!.instance.apply({ enabled: false, historyDays: null })
  const { keys } = await paginate(5, 'relevance')
  expect(new Set(keys).size).toBe(keys.length)
  expect([...keys].sort()).toEqual(
    [
      ...hosts[0]!.sessionIds.map((id) => `local/${id}`),
      ...hosts[1]!.sessionIds.map((id) => `ssh:alpha/${id}`)
    ].sort()
  )
  const first = resultsOf(await searchAllExecutionHosts({ query: 'needle', limit: 5 }, legs()))
  expect(first.hosts).toContainEqual({
    executionHostId: 'ssh:beta',
    outcome: 'disabled'
  })
})
