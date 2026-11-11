import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isOrcaSessionId } from '../../../shared/orca-session-address'
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
  it('gives sequential runs in one pane distinct ids and keeps each conversation on its own', () => {
    const identities = service(databasePath())
    const first = identities.identify(sighting({ id: 'S1' }), 'tab:pane')
    const second = identities.identify(sighting({ id: 'S2' }), 'tab:pane')
    expect(first).not.toBeNull()
    expect(isOrcaSessionId(first!)).toBe(true)
    expect(second).not.toBe(first)
    expect(identities.identify(sighting({ id: 'S1' }), 'tab:pane')).toBe(first)
  })

  it('names one conversation the same from any pane', () => {
    const identities = service(databasePath())
    const original = identities.identify(sighting({ id: 'S1' }), 'tab-a:pane')
    expect(identities.identify(sighting({ id: 'S1' }), 'tab-b:pane')).toBe(original)
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
    expect(
      agentProviderKeyOf({
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'S1' },
        connectionId: 'ssh-target'
      })
    ).toBeNull()
  })

  it('converges concurrent first sightings and survives a new service instance', () => {
    const path = databasePath()
    const left = new AgentIdentityStore(path)
    const right = new AgentIdentityStore(path)
    opened.push(left, right)
    const id = left.identify(key({ id: 'S1' }))
    expect(right.identify(key({ id: 'S1' }))).toBe(id)
    expect(service(path).identify(sighting({ id: 'S1' }), 'tab:pane')).toBe(id)
    expect(right.has(id)).toBe(true)
  })
})
