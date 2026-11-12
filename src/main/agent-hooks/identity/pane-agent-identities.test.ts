import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { isOrcaSessionId } from '../../../shared/orca-session-address'
import SyncDatabase from '../../sqlite/sync-database'
import { AgentIdentityWorkerClient } from './agent-identity-worker-client'
import {
  InProcessAgentIdentityClient,
  ScriptedIdentityWorkers
} from './agent-identity-client.test-fixtures'
import {
  PaneAgentIdentities,
  type ProviderSessionSighting,
  type SettledAgentIdentityPlace
} from './pane-agent-identities'

const directories: string[] = []
const opened: { close(): void }[] = []
const buildDir = mkdtempSync(join(tmpdir(), 'orca-agent-identity-worker-'))
const workerEntry = join(buildDir, 'agent-identity-worker-entry.js')

beforeAll(async () => {
  await build({
    entryPoints: ['src/main/agent-hooks/identity/agent-identity-worker-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: workerEntry,
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(buildDir, { recursive: true, force: true }))
afterEach(() => {
  for (const service of opened.splice(0)) {
    service.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-agent-identities-'))
  directories.push(directory)
  return join(directory, 'agent-identities.db')
}

/** The real worker thread, as the hook server runs it. */
function workerService(path: string): PaneAgentIdentities {
  const identities = new PaneAgentIdentities(
    () => path,
    () => {},
    () => new AgentIdentityWorkerClient(() => new Worker(workerEntry))
  )
  opened.push(identities)
  return identities
}

function inProcessService(path: string, client: InProcessAgentIdentityClient) {
  const settled: SettledAgentIdentityPlace[] = []
  const identities = new PaneAgentIdentities(
    () => path,
    (places) => settled.push(...places),
    () => client
  )
  opened.push(identities)
  return { identities, settled }
}

function sighting(
  options: Partial<ProviderSessionSighting> & { id: string; transcriptPath?: string }
): ProviderSessionSighting {
  return {
    agent: options.agent ?? 'claude',
    providerSession: {
      key: 'session_id',
      id: options.id,
      ...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {})
    },
    connectionId: options.connectionId ?? null
  }
}

describe('PaneAgentIdentities through the identity worker', () => {
  it('names exact keys, never relinks, converges across workers and keeps newer files read-only', async () => {
    const path = databasePath()
    const identities = workerService(path)
    const first = await identities.identify(sighting({ id: 'S1' }))
    expect(isOrcaSessionId(first!)).toBe(true)
    expect(await identities.identify(sighting({ id: 'S2' }))).not.toBe(first)
    expect(await identities.identify(sighting({ id: 'S1', connectionId: 'wsl:Ubuntu' }))).not.toBe(
      first
    )
    // The locator separates conversations only where resume uses it.
    expect(await identities.identify(sighting({ id: 'S1', transcriptPath: '/t/x.jsonl' }))).toBe(
      first
    )
    const pi = await identities.identify(sighting({ agent: 'pi', id: 'P', transcriptPath: '/a' }))
    expect(
      await identities.identify(sighting({ agent: 'pi', id: 'P', transcriptPath: '/b' }))
    ).not.toBe(pi)
    expect(await identities.identify(sighting({ id: 'S1', connectionId: 'ssh-target' }))).toBeNull()
    // A second worker on the same file finds the committed link.
    expect(await workerService(path).identify(sighting({ id: 'S1' }))).toBe(first)
    expect(await workerService(path).isTerminalIdentity(first!)).toBe(true)

    for (const service of opened.splice(0)) {
      service.close()
    }
    const newer = new SyncDatabase(path)
    // The closed services' workers release the file as they exit.
    newer.pragma('busy_timeout = 5000')
    newer.exec('PRAGMA user_version = 9')
    newer.close()
    const readOnly = workerService(path)
    expect(await readOnly.identify(sighting({ id: 'S1' }))).toBe(first)
    expect(await readOnly.identify(sighting({ id: 'unlinked' }))).toBeNull()
  })
})

/** The real client and request queue over scripted worker threads, with fake time. */
function scriptedService(
  workers: ScriptedIdentityWorkers,
  path: () => string | null = () => 'ids.db'
) {
  const settled: SettledAgentIdentityPlace[] = []
  const identities = new PaneAgentIdentities(
    path,
    (places) => settled.push(...places),
    () => new AgentIdentityWorkerClient(workers.factory)
  )
  opened.push(identities)
  return { identities, settled }
}

function admit(identities: PaneAgentIdentities, place: string, providerSessionId: string): void {
  identities.setPlace(
    place,
    place,
    identities.assign(sighting({ id: providerSessionId }), undefined)
  )
}

describe('PaneAgentIdentities demand and completion', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    [200, 6],
    [2_000, 8]
  ])('settles a healthy %i-key burst with one request per key (%ims each)', async (keys, ms) => {
    vi.useFakeTimers()
    const workers = new ScriptedIdentityWorkers()
    workers.serviceMs = ms
    const { identities, settled } = scriptedService(workers)
    for (let place = 0; place < keys; place++) {
      admit(identities, `p${place}`, `k${place}`)
    }
    // Far past the old queue-age deadline: every key still settles, without another event.
    await vi.advanceTimersByTimeAsync(keys * ms + 1_000)
    expect(settled.length).toBe(keys)
    expect(workers.identifyPosts()).toBe(keys)
    expect(workers.spawns).toBe(1)
  })

  it('times out a stuck operation; an expired click leaves the row demand to the next attempt', async () => {
    vi.useFakeTimers()
    const workers = new ScriptedIdentityWorkers()
    workers.answer = () => 'never'
    const { identities, settled } = scriptedService(workers)
    admit(identities, 'p', 'k')
    const click = identities.identify(sighting({ id: 'k' }))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await click).toBeNull()
    workers.answer = (request) =>
      request.kind === 'identify' ? { id: request.id, ok: true, value: 'claude_k_answer' } : 'never'
    // The owner's single wake retries the still-demanded row after the backoff.
    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled.map((place) => place.identity.id)).toEqual(['claude_k_answer'])
  })

  it.each([200, 2_000])('sends only what current rows still need (%i keys)', async (keys) => {
    vi.useFakeTimers()
    const workers = new ScriptedIdentityWorkers()
    workers.serviceMs = 5
    const { identities, settled } = scriptedService(workers)
    for (let place = 0; place < keys; place++) {
      admit(identities, `p${place}`, `k${place}`)
    }
    // Every row but the last moves to one shared conversation before the first answer.
    for (let place = 0; place < keys - 1; place++) {
      admit(identities, `p${place}`, 'shared')
    }
    await vi.advanceTimersByTimeAsync(keys * 10)
    // Nothing was sent before the rows moved, and replaced keys never are.
    expect(workers.identifyPosts()).toBe(2)
    expect(settled.filter((place) => place.identity.id === 'claude_shared').length).toBe(keys - 1)
    expect(settled.filter((place) => place.identity.id === `claude_k${keys - 1}`).length).toBe(1)
    // Detaching one subscriber leaves the others' answer in place for a new pane.
    identities.setPlace('p0', 'p0', undefined)
    expect(identities.assign(sighting({ id: 'shared' }), undefined)?.id).toBe('claude_shared')
  })

  it.each([200, 2_000])(
    'gates %i queued lookups and membership checks behind one failure',
    async (count) => {
      vi.useFakeTimers()
      const workers = new ScriptedIdentityWorkers()
      workers.answer = (request) => ({ id: request.id, ok: false, error: 'disk I/O error' })
      const { identities, settled } = scriptedService(workers)
      for (let place = 0; place < count; place++) {
        admit(identities, `p${place}`, `k${place}`)
      }
      const memberships = Array.from({ length: count }, (_, n) =>
        identities.isTerminalIdentity(`claude_m${n}`)
      )
      await vi.advanceTimersByTimeAsync(1)
      expect(workers.posts.length).toBe(1)
      // Inside the window a refusal does not probe, and a Copy click is the one override.
      expect(await identities.isTerminalIdentity('claude_later')).toBeUndefined()
      const click = identities.identify(sighting({ id: 'k0' }))
      await vi.advanceTimersByTimeAsync(1)
      expect(await click).toBeNull()
      expect(workers.posts.length).toBe(2)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(new Set(await Promise.all(memberships))).toEqual(new Set([undefined]))
      // The single wake probes once per window; a failed probe re-arms it once.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(workers.posts.length).toBe(3)
      workers.answer = (request) =>
        request.kind === 'identify'
          ? { id: request.id, ok: true, value: `claude_${request.key.providerSessionId}` }
          : 'never'
      await vi.advanceTimersByTimeAsync(30_001)
      await vi.advanceTimersByTimeAsync(count * 2)
      // Storage recovered: every idle row settles without another hook.
      expect(settled.length).toBe(count)
      expect(workers.spawns).toBeLessThanOrEqual(4)
    }
  )

  it('arms no wake without row demand, and cancels it with the last demand', async () => {
    vi.useFakeTimers()
    const workers = new ScriptedIdentityWorkers()
    workers.answer = (request) => ({ id: request.id, ok: false, error: 'locked' })
    const { identities } = scriptedService(workers)
    admit(identities, 'p', 'k')
    await vi.advanceTimersByTimeAsync(1)
    identities.setPlace('p', 'p', undefined)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(workers.posts.length).toBe(1)
  })

  it('never runs a second worker beside a retiring one, and fences answers to their owner', async () => {
    vi.useFakeTimers()
    const workers = new ScriptedIdentityWorkers()
    workers.holdExit = true
    workers.serviceMs = 1
    let path = 'a.db'
    const { identities, settled } = scriptedService(workers, () => path)
    admit(identities, 'p', 'k')
    await vi.advanceTimersByTimeAsync(5)
    identities.close()
    admit(identities, 'q', 'j')
    await vi.advanceTimersByTimeAsync(5)
    expect(workers.live).toBe(1)
    expect(workers.identifyPosts()).toBe(1)
    workers.releaseExits()
    await vi.advanceTimersByTimeAsync(5)
    expect(workers.maxLive).toBe(1)
    expect(workers.identifyPosts()).toBe(2)

    // An answer accepted just before the owner closes is not handed to the waiting click.
    workers.holdExit = false
    workers.serviceMs = 0
    const closing: PaneAgentIdentities = new PaneAgentIdentities(
      () => path,
      () => closing.close(),
      () => new AgentIdentityWorkerClient(workers.factory)
    )
    opened.push(closing)
    admit(closing, 'late-row', 'late')
    const click = closing.identify(sighting({ id: 'late' }))
    await vi.advanceTimersByTimeAsync(5)
    expect(await click).toBeNull()

    // A different store never reuses another store's answer for the same key.
    admit(identities, 'r', 'k')
    await vi.advanceTimersByTimeAsync(5)
    const before = workers.identifyPosts()
    path = 'b.db'
    admit(identities, 's', 'k')
    await vi.advanceTimersByTimeAsync(5)
    expect(workers.identifyPosts()).toBe(before + 1)
    expect(workers.posts.at(-1)).toMatchObject({ kind: 'identify', path: 'b.db' })
    expect(settled.at(-1)?.place).toBe('s')
  })

  it('settles a read-only miss as no id', async () => {
    const path = databasePath()
    const client = new InProcessAgentIdentityClient()
    const key = { executionHost: 'local', wslDistro: '', agent: 'claude', locator: '' }
    await client.identify(path, { ...key, providerSessionId: 'linked' })
    // Moving the handler to another file closes this one, so it reopens at the newer version.
    await client.identify(databasePath(), { ...key, providerSessionId: 'elsewhere' })
    const newer = new SyncDatabase(path)
    newer.exec('PRAGMA user_version = 9')
    newer.close()
    const { identities, settled } = inProcessService(path, client)
    identities.setPlace('a', 'a', identities.assign(sighting({ id: 'unlinked' }), undefined))
    expect(await identities.identify(sighting({ id: 'unlinked' }))).toBeNull()
    expect(settled.map((place) => place.identity)).toEqual([expect.objectContaining({ id: null })])
    expect(settled[0]?.identity.pending).toBeUndefined()
  })
})
