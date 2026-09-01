/**
 * The desktop authority's end of the scoped-list and owner-fenced contracts:
 * a parameterless read still answers with everything it stores, a scoped read is
 * qualified per row, and no mutation or dispatch may cross an incarnation
 * boundary — including one that a client silently declines to name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Automation
}

const REPOS: Repo[] = [
  { id: 'repo-local', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 1 },
  {
    id: 'repo-ssh',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-1'
  }
] as Repo[]

const TARGETS: SshTarget[] = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

const AUTOMATIONS: Automation[] = [
  automation({ id: 'local-1', name: 'A local' }),
  automation({
    id: 'ssh-1-a',
    name: 'B ssh',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7
  }),
  automation({
    id: 'orphan-1',
    name: 'C orphan',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3,
    enabled: false
  })
]

async function createStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: REPOS,
      sshTargets: TARGETS,
      sshTargetGenerationCounter: 7,
      automations: AUTOMATIONS
    }),
    'utf-8'
  )
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-fencing-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

const OWNED_SSH = { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } } as const

describe('scoped automation list', () => {
  it('keeps the parameterless list at the authority-complete legacy shape', async () => {
    const store = await createStore()
    expect(store.listAutomations().map((entry) => entry.id)).toEqual([
      'local-1',
      'ssh-1-a',
      'orphan-1'
    ])
  })

  it('qualifies every row and reports the authority orphan count', async () => {
    const store = await createStore()
    const result = store.listAutomationsForScope({ selector: { kind: 'self' } })
    expect(result.automations.map((entry) => entry.id)).toEqual(['local-1'])
    expect(result.items).toEqual([
      { automationId: 'local-1', selector: { kind: 'self' }, usageSummary: null }
    ])
    expect(result.orphanCount).toBe(1)
  })

  it('answers an SSH scope only for the requested registration', async () => {
    const store = await createStore()
    const result = store.listAutomationsForScope({
      selector: { kind: 'ssh', targetId: 'ssh-1', expectedTargetGeneration: 7 }
    })
    expect(result.automations.map((entry) => entry.id)).toEqual(['ssh-1-a'])
    expect(() =>
      store.listAutomationsForScope({
        selector: { kind: 'ssh', targetId: 'ssh-1', expectedTargetGeneration: 6 }
      })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged }))
    expect(() =>
      store.listAutomationsForScope({
        selector: { kind: 'ssh', targetId: 'ssh-gone', expectedTargetGeneration: 3 }
      })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved }))
  })

  it('exposes orphans only under the orphan scope', async () => {
    const store = await createStore()
    const result = store.listAutomationsForScope({ selector: { kind: 'orphan' } })
    expect(result.automations.map((entry) => entry.id)).toEqual(['orphan-1'])
    expect(result.items[0]?.selector.kind).toBe('orphan')
  })
})

describe('owner-fenced mutations', () => {
  it('passes when the captured owner still matches', async () => {
    const store = await createStore()
    const updated = store.updateAutomation(
      'ssh-1-a',
      { enabled: false },
      { expectedOwner: OWNED_SSH }
    )
    expect(updated.enabled).toBe(false)
  })

  it('refuses an update, delete, and dispatch fenced on a stale generation', async () => {
    const store = await createStore()
    const stale = { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 } } as const
    const conflict = expect.objectContaining({
      code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    })
    expect(() =>
      store.updateAutomation('ssh-1-a', { enabled: false }, { expectedOwner: stale })
    ).toThrowError(conflict)
    expect(() => store.deleteAutomation('ssh-1-a', { expectedOwner: stale })).toThrowError(conflict)
    expect(() =>
      store.assertAutomationOwnerFence({
        id: 'ssh-1-a',
        expectedOwner: stale,
        operation: 'execute'
      })
    ).toThrowError(conflict)
    expect(store.listAutomations().find((entry) => entry.id === 'ssh-1-a')?.enabled).toBe(true)
  })

  // Optional on the wire is not unenforced: a caller that names no host may not
  // mutate a record fenced to an SSH registration.
  it('refuses an ownerless mutation of a generation-bearing SSH record', async () => {
    const store = await createStore()
    const required = expect.objectContaining({
      code: AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired
    })
    expect(() => store.updateAutomation('ssh-1-a', { enabled: false })).toThrowError(required)
    expect(() => store.deleteAutomation('ssh-1-a')).toThrowError(required)
    expect(() =>
      store.assertAutomationOwnerFence({ id: 'ssh-1-a', operation: 'execute' })
    ).toThrowError(required)
    expect(store.listAutomations().find((entry) => entry.id === 'ssh-1-a')?.enabled).toBe(true)
    expect(store.listAutomations()).toHaveLength(3)
  })

  it('leaves a legacy client unaffected on a self record', async () => {
    const store = await createStore()
    expect(store.updateAutomation('local-1', { enabled: false }).enabled).toBe(false)
    store.deleteAutomation('local-1')
    expect(store.listAutomations().map((entry) => entry.id)).toEqual(['ssh-1-a', 'orphan-1'])
  })

  it('keeps delete available on an orphan but refuses to dispatch it', async () => {
    const store = await createStore()
    expect(() =>
      store.assertAutomationOwnerFence({ id: 'orphan-1', operation: 'execute' })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved }))
    store.deleteAutomation('orphan-1', { expectedOwner: { selector: { kind: 'orphan' } } })
    expect(store.listAutomations().map((entry) => entry.id)).toEqual(['local-1', 'ssh-1-a'])
  })

  it('rejects a create whose destination is not a current registration', async () => {
    const store = await createStore()
    const input = {
      name: 'New',
      prompt: 'go',
      agentId: 'claude' as const,
      projectId: 'repo-ssh',
      workspaceMode: 'new_per_run' as const,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 0
    }
    expect(() =>
      store.createAutomation(input, {
        destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 } }
      })
    ).toThrowError(
      expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination })
    )
    expect(() =>
      store.createAutomation(input, { destination: { selector: { kind: 'self' } } })
    ).toThrowError(
      expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination })
    )
    const created = store.createAutomation(input, {
      destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
    })
    expect(created.executionTargetGeneration).toBe(7)
  })
})

/**
 * A client with no target registry of its own reads the owner, then acts on it.
 * The projection is what makes the fence satisfiable off-host rather than a wall.
 */
describe('projected owner precondition', () => {
  it('reuses the complete projection until automation state changes', async () => {
    const store = await createStore()
    const first = store.listAutomationsForScope()
    expect(store.listAutomationsForScope()).toBe(first)

    store.updateAutomation('local-1', { enabled: false })
    expect(store.listAutomationsForScope()).not.toBe(first)
  })

  it('projects the fenceable owner for each kind of record', async () => {
    const store = await createStore()
    expect(store.automationOwnerPrecondition('ssh-1-a')).toEqual(OWNED_SSH)
    expect(store.automationOwnerPrecondition('local-1')).toEqual({ selector: { kind: 'self' } })
    // The orphan issue is diagnosis, not identity, so it stays out of the precondition.
    expect(store.automationOwnerPrecondition('orphan-1')).toEqual({
      selector: { kind: 'orphan' }
    })
    expect(store.automationOwnerPrecondition('missing')).toBeNull()
  })

  it('satisfies the fence it was projected from, on the record that used to refuse', async () => {
    const store = await createStore()
    const owner = store.automationOwnerPrecondition('ssh-1-a')!
    expect(() => store.updateAutomation('ssh-1-a', { enabled: false })).toThrowError(
      expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired })
    )
    expect(
      store.updateAutomation('ssh-1-a', { enabled: false }, { expectedOwner: owner }).enabled
    ).toBe(false)
  })

  // Execute is refused whatever the caller names: an orphan has no host to run on.
  it('does not let an orphan precondition unlock a dispatch', async () => {
    const store = await createStore()
    const owner = store.automationOwnerPrecondition('orphan-1')!
    expect(() =>
      store.assertAutomationOwnerFence({
        id: 'orphan-1',
        expectedOwner: owner,
        operation: 'execute'
      })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved }))
    store.deleteAutomation('orphan-1', { expectedOwner: owner })
    expect(store.listAutomations().map((entry) => entry.id)).not.toContain('orphan-1')
  })
})
