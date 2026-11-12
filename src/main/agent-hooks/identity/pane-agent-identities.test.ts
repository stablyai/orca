import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { isOrcaSessionId } from '../../../shared/orca-session-address'
import SyncDatabase from '../../sqlite/sync-database'
import { AgentIdentityWorkerClient } from './agent-identity-worker-client'
import { InProcessAgentIdentityClient } from './agent-identity-client.test-fixtures'
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

const flush = () => new Promise((resolve) => setImmediate(resolve))

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

describe('PaneAgentIdentities admission and completion', () => {
  it('shares one request per key and settles only the places still pending on it', async () => {
    const client = new InProcessAgentIdentityClient()
    client.hold = true
    const { identities, settled } = inProcessService(databasePath(), client)
    // Two panes name S1 and a third changes from S1 to S2 before the answer.
    for (const place of ['a', 'b', 'c']) {
      identities.setPlace(place, place, identities.assign(sighting({ id: 'S1' }), undefined))
    }
    const clicked = identities.identify(sighting({ id: 'S1' }))
    identities.setPlace('c', 'c', identities.assign(sighting({ id: 'S2' }), undefined))
    identities.setPlace('b', 'b', undefined)
    expect(client.identifyRequests).toBe(2)
    client.release()
    const id = await clicked
    await flush()
    expect(settled.map((place) => [place.place, place.identity.id])).toEqual([
      ['a', id],
      ['c', expect.any(String)]
    ])
    expect(settled[1]?.identity.id).not.toBe(id)
    // A new pane naming S1 now reuses the settled answer without asking again.
    expect(identities.assign(sighting({ id: 'S1' }), undefined)?.id).toBeNull()
    identities.setPlace('a', 'a', { ...settled[0]!.identity })
    expect(identities.assign(sighting({ id: 'S1' }), undefined)?.id).toBe(id)
    expect(client.identifyRequests).toBe(3)
  })

  it('drops a reply that arrives after the owner closed', async () => {
    const client = new InProcessAgentIdentityClient()
    client.hold = true
    const { identities, settled } = inProcessService(databasePath(), client)
    identities.setPlace('a', 'a', identities.assign(sighting({ id: 'S1' }), undefined))
    identities.close()
    client.release()
    await flush()
    expect(settled).toEqual([])
  })

  it('backs off after a failure, lets a click retry, and recovers the committed id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const client = new InProcessAgentIdentityClient()
      // The first transaction commits but its reply is lost, as when the worker crashes.
      client.failAfterCommit = 1
      const { identities, settled } = inProcessService(databasePath(), client)
      identities.setPlace('a', 'a', identities.assign(sighting({ id: 'S1' }), undefined))
      await flush()
      for (let event = 0; event < 100; event++) {
        identities.assign(sighting({ id: `S${event}` }), undefined)
      }
      expect(client.identifyRequests).toBe(1)
      // The click asks again inside the window and gets the id the lost reply committed.
      const id = await identities.identify(sighting({ id: 'S1' }))
      expect(isOrcaSessionId(id!)).toBe(true)
      expect(settled.map((place) => place.identity.id)).toEqual([id])
      expect(client.identifyRequests).toBe(2)
      vi.setSystemTime(Date.now() + 30_001)
      identities.assign(sighting({ id: 'S2' }), undefined)
      expect(client.identifyRequests).toBe(3)
    } finally {
      vi.useRealTimers()
    }
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
