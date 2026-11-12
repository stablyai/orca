import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isOrcaSessionId } from '../../../shared/orca-session-address'
import SyncDatabase from '../../sqlite/sync-database'
import { AgentIdentityStore } from './agent-identity-store'
import {
  agentProviderKeyOf,
  PaneAgentIdentities,
  type ProviderSessionSighting
} from './pane-agent-identities'

const directories: string[] = []
const opened: { close(): void }[] = []
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

function service(path: string): PaneAgentIdentities {
  const identities = new PaneAgentIdentities(() => path)
  opened.push(identities)
  return identities
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

function key(options: Parameters<typeof sighting>[0]) {
  const resolved = agentProviderKeyOf(sighting(options))
  if (!resolved) {
    throw new Error('expected a provider key')
  }
  return resolved
}

describe('PaneAgentIdentities', () => {
  it('gives distinct conversations distinct ids and never relinks a named one', () => {
    const identities = service(databasePath())
    const first = identities.identify(sighting({ id: 'S1' }))
    const second = identities.identify(sighting({ id: 'S2' }))
    expect(first).not.toBeNull()
    expect(isOrcaSessionId(first!)).toBe(true)
    expect(second).not.toBe(first)
    expect(identities.identify(sighting({ id: 'S1' }))).toBe(first)
  })

  it('separates distros and locators only where resume uses them', () => {
    const identities = service(databasePath())
    const native = identities.identify(sighting({ id: 'S1' }))
    expect(identities.identify(sighting({ id: 'S1', connectionId: 'wsl:Ubuntu' }))).not.toBe(native)
    expect(identities.identify(sighting({ id: 'S1', transcriptPath: '/t/other.jsonl' }))).toBe(
      native
    )
    const pi = identities.identify(sighting({ agent: 'pi', id: 'P', transcriptPath: '/a.jsonl' }))
    expect(
      identities.identify(sighting({ agent: 'pi', id: 'P', transcriptPath: '/b.jsonl' }))
    ).not.toBe(pi)
    expect(identities.identify(sighting({ id: 'S1', connectionId: 'ssh-target' }))).toBeNull()
  })

  it('converges concurrent first sightings and survives a reopen', () => {
    const path = databasePath()
    const left = new AgentIdentityStore(path)
    const right = new AgentIdentityStore(path)
    opened.push(left, right)
    const id = left.identify(key({ id: 'S1' }))
    expect(right.identify(key({ id: 'S1' }))).toBe(id)
    expect(service(path).identify(sighting({ id: 'S1' }))).toBe(id)
  })

  it('never mints in a read-only file and backs off a failing one', () => {
    const path = databasePath()
    new AgentIdentityStore(path).close()
    const newer = new SyncDatabase(path)
    newer.exec('PRAGMA user_version = 9')
    newer.close()
    const readOnly = service(path)
    // A write on a read-only connection would throw and start the backoff (undefined); a
    // lookup-only miss settles as "no id" every time.
    for (let publication = 0; publication < 100; publication++) {
      expect(readOnly.assign(sighting({ id: 'unlinked' }), undefined)).toEqual({
        key: key({ id: 'unlinked' }),
        id: null
      })
    }

    vi.useFakeTimers()
    try {
      const writes = vi.fn(() => {
        throw new Error('database is locked')
      })
      const failing = new PaneAgentIdentities(
        () => 'failing.db',
        () => ({ readOnly: false, identify: writes, has: () => false, close() {} })
      )
      for (let publication = 0; publication < 100; publication++) {
        expect(failing.assign(sighting({ id: `S${publication}` }), undefined)).toMatchObject({
          id: null,
          pending: true
        })
      }
      expect(writes).toHaveBeenCalledTimes(1)
      // A Copy click retries once inside the window; publications stay quiet.
      expect(failing.identify(sighting({ id: 'S0' }))).toBeNull()
      failing.assign(sighting({ id: 'S1' }), undefined)
      expect(writes).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(30_001)
      failing.assign(sighting({ id: 'S1' }), undefined)
      expect(writes).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
