/**
 * A definition change must name the host it affected, and a change that moves a
 * record between hosts must name both — a subscriber that never hears about the
 * source keeps rendering a row that has left it.
 *
 * Runs against the real Store so the published selectors are the ones the
 * persistence layer actually derives, not fixture stand-ins. The runtime methods
 * are the single publication site for every transport (local IPC and remote RPC).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPOS = [
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

const TARGETS = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'local-1',
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

const AUTOMATIONS = [
  automation({}),
  automation({
    id: 'ssh-1-a',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7
  }),
  automation({
    id: 'orphan-1',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3
  })
]

async function makeRuntime() {
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
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  const store = new Store()
  const { OrcaRuntimeService } = await import('./orca-runtime')
  const runtime = new OrcaRuntimeService(store as never)
  const published: AutomationsChangedPayload[] = []
  vi.spyOn(runtime, 'notifyAutomationsChanged').mockImplementation(
    (payload: AutomationsChangedPayload = {}) => {
      published.push(payload)
    }
  )
  return { store, runtime, published }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-publish-'))
  // Why: the store resolves orca-data.json through the app environment, so the
  // suite's fixture directory must be what `userData` answers with.
  installFakeAppEnvironment({
    getPath: (name) => (name === 'userData' ? testState.dir : tmpdir())
  })
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('scoped automationsChanged publication', () => {
  it('names the host a delete removed a row from', async () => {
    const { runtime, published } = await makeRuntime()
    runtime.deleteAutomation('ssh-1-a', {
      selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 }
    })
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
  })

  it('names the orphan bucket when an unowned row is deleted', async () => {
    const { runtime, published } = await makeRuntime()
    runtime.deleteAutomation('orphan-1', { selector: { kind: 'orphan' } })
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'orphan' } }])
  })

  it('publishes source and destination when an update moves a record between hosts', async () => {
    const { runtime, published, store } = await makeRuntime()
    await runtime.updateAutomation(
      'local-1',
      { repo: 'repo-ssh' },
      {
        expectedOwner: { selector: { kind: 'self' } },
        destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
      }
    )
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'self' } },
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
    expect(store.automationChangeSelector('local-1')).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1'
    })
  })

  it('publishes one event when an update leaves the record on the same host', async () => {
    const { runtime, published } = await makeRuntime()
    await runtime.updateAutomation(
      'local-1',
      { enabled: false },
      { expectedOwner: { selector: { kind: 'self' } } }
    )
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'self' } }])
  })

  // Why: an unnameable destination is exactly when scoping is unsafe — a subscriber scoped
  // elsewhere would never hear about the row it is still rendering. The publication has to
  // degrade to one unscoped authority event rather than name only the stale source.
  it('degrades to an unscoped event when the store cannot name the destination', async () => {
    const { store, runtime, published } = await makeRuntime()
    const selector = store.automationChangeSelector.bind(store)
    let updated = false
    vi.spyOn(store, 'automationChangeSelector').mockImplementation((id: string) =>
      updated ? null : selector(id)
    )
    const update = runtime.updateAutomation(
      'local-1',
      { enabled: false },
      { expectedOwner: { selector: { kind: 'self' } } }
    )
    updated = true
    await update

    expect(published).toEqual([{ reason: 'definition' }])
  })
})
