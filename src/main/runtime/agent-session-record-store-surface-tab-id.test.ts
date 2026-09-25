/**
 * The host-owned id of the tab that shows a structured chat, as the record store persists it.
 * Separate from the store's main suite only because that file is at its line cap.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string
let counter = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-surface-tab-id-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

async function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

describe('surface tab id', () => {
  const LEGACY_TAB_ID = 'structured-agent-session-session-alpha'

  it('records the reserved tab id and refuses a second record under it', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    expect(store.getRecord('session-alpha')?.surfaceTabId).toBe('tab-alpha')
    const persisted = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
    expect(persisted.records['session-alpha'].surfaceTabId).toBe('tab-alpha')

    await expect(
      store.reserveOwner(
        reserveRequest({
          sessionId: 'session-beta',
          surfaceTabId: 'tab-alpha',
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
    expect(store.getRecord('session-beta')).toBeNull()
  })

  it('refuses a tab id that could not prefix a pane key', async () => {
    const store = await open()
    await expect(
      store.reserveOwner(reserveRequest({ surfaceTabId: 'agent-session:session-alpha' }))
    ).rejects.toThrow('agent_session_operation_invalid')
  })

  it('backfills a record written before the field existed with the id clients derived', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    const filePath = agentSessionStorePath(directory)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    delete raw.records['session-alpha'].surfaceTabId
    await writeFile(filePath, JSON.stringify(raw))

    const reopened = await open()
    // In memory at once, so every reader of the record sees one.
    expect(reopened.getRecord('session-alpha')?.surfaceTabId).toBe(LEGACY_TAB_ID)
    // Not on disk yet: an open must not write, or another holder of the file mid-restart would
    // read it as an external change.
    expect(
      JSON.parse(await readFile(filePath, 'utf-8')).records['session-alpha']
    ).not.toHaveProperty('surfaceTabId')

    // The first transaction carries it to disk, and a later open finds nothing left to fill.
    await reopened.setSessionTabVisibility('session-alpha', true)
    expect(
      JSON.parse(await readFile(filePath, 'utf-8')).records['session-alpha'].surfaceTabId
    ).toBe(LEGACY_TAB_ID)
    const settled = await readFile(filePath, 'utf-8')
    await open()
    expect(await readFile(filePath, 'utf-8')).toBe(settled)
  })

  it('refills the id when another holder rewrites the file, without forcing a save', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    const filePath = agentSessionStorePath(directory)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    // An older build's write, which never carries the field.
    delete raw.records['session-alpha'].surfaceTabId
    raw.visibleSessionIds = []
    const external = JSON.stringify(raw)
    await writeFile(filePath, external)

    // A transaction that changes nothing still reloads the externally changed file first.
    await store.setSessionTabVisibility('session-alpha', false)
    expect(store.getRecord('session-alpha')?.surfaceTabId).toBe(LEGACY_TAB_ID)
    // The reload marked every lease unadjudicated; a refill must not persist that verdict.
    expect(await readFile(filePath, 'utf-8')).toBe(external)
  })

  it('quarantines a persisted record whose tab id contains a colon', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    const filePath = agentSessionStorePath(directory)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    raw.records['session-alpha'].surfaceTabId = 'agent-session:session-alpha'
    await writeFile(filePath, JSON.stringify(raw))
    expect((await open()).isSessionUnreadable('session-alpha')).toBe(true)
  })
})
