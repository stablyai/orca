import { describe, it, expect } from 'vitest'
import {
  migrateAutomationHostFilterSshTargetId,
  migrateAutomationsForSshReadoption
} from './automation-ssh-readoption-migration'
import { hostStableKey } from '../../shared/automation-owner-key'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'

const NOW = 1_700_000_000_000
const OLD_ID = 'ssh-1738-a9f3x'
const NEW_ID = 'ssh-1799-b2k7z'

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'ssh',
    executionTargetId: OLD_ID,
    executionTargetGeneration: 3,
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: NOW,
    enabled: true,
    nextRunAt: NOW,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function migrate(
  automations: Automation[],
  generation: number | undefined,
  runs: AutomationRun[] = []
) {
  return migrateAutomationsForSshReadoption({
    automations,
    automationRuns: runs,
    oldTargetId: OLD_ID,
    newTargetId: NEW_ID,
    newTargetGeneration: generation
  })
}

function runContext(hostId: string) {
  return {
    kind: 'workspace-run' as const,
    projectId: 'project-1',
    hostId: hostId as `ssh:${string}`,
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    path: '/srv/repo'
  }
}

function uiWithFilter(hostKey: string): PersistedUIState {
  return { automationHostFilter: { kind: 'host', hostKey } } as PersistedUIState
}

describe('migrateAutomationsForSshReadoption', () => {
  it('re-points the owner and adopts the re-added registration generation', () => {
    const automation = makeAutomation()
    expect(migrate([automation], 9)).toBe(true)
    expect(automation.executionTargetId).toBe(NEW_ID)
    expect(automation.executionTargetGeneration).toBe(9)
  })

  it('drops a stale capture when the re-added target carries no generation', () => {
    const automation = makeAutomation()
    expect(migrate([automation], undefined)).toBe(true)
    expect(automation.executionTargetId).toBe(NEW_ID)
    expect('executionTargetGeneration' in automation).toBe(false)
  })

  it('migrates run and source context host ids, including for local records', () => {
    const automation = makeAutomation({
      executionTargetType: 'local',
      executionTargetId: 'local',
      executionTargetGeneration: undefined,
      runContext: runContext(`ssh:${OLD_ID}`),
      sourceContext: {
        kind: 'task-source',
        provider: 'github',
        projectId: 'project-1',
        hostId: `ssh:${OLD_ID}`
      }
    })
    expect(migrate([automation], 9)).toBe(true)
    expect(automation.runContext?.hostId).toBe(`ssh:${NEW_ID}`)
    expect(automation.sourceContext?.hostId).toBe(`ssh:${NEW_ID}`)
    // A local record's execution target is not an SSH reference and must stay untouched.
    expect(automation.executionTargetId).toBe('local')
    expect(automation.executionTargetGeneration).toBeUndefined()
  })

  it('leaves automations on other targets alone', () => {
    const other = makeAutomation({ id: 'auto-2', executionTargetId: 'ssh-other' })
    expect(migrate([other], 9)).toBe(false)
    expect(other.executionTargetId).toBe('ssh-other')
    expect(other.executionTargetGeneration).toBe(3)
  })

  it('re-points run history so workspace navigation survives re-adoption', () => {
    const run = {
      id: 'run-1',
      automationId: 'auto-1',
      runContext: runContext(`ssh:${OLD_ID}`)
    } as AutomationRun
    expect(migrate([], 9, [run])).toBe(true)
    expect(run.runContext?.hostId).toBe(`ssh:${NEW_ID}`)
  })
})

describe('migrateAutomationHostFilterSshTargetId', () => {
  it('follows the re-adopted id', () => {
    const ui = uiWithFilter(
      hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: OLD_ID } })
    )
    expect(migrateAutomationHostFilterSshTargetId(ui, OLD_ID, NEW_ID)).toBe(true)
    expect(ui.automationHostFilter).toEqual({
      kind: 'host',
      hostKey: hostStableKey({
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: NEW_ID }
      })
    })
  })

  it('never rewrites a runtime authority filter that reuses the same target id', () => {
    const hostKey = hostStableKey({
      authority: { kind: 'runtime', environmentId: 'env-1' },
      selector: { kind: 'ssh', targetId: OLD_ID }
    })
    const ui = uiWithFilter(hostKey)
    expect(migrateAutomationHostFilterSshTargetId(ui, OLD_ID, NEW_ID)).toBe(false)
    expect(ui.automationHostFilter).toEqual({ kind: 'host', hostKey })
  })

  it('ignores All hosts, other hosts, and unparseable persisted values', () => {
    const all = { automationHostFilter: { kind: 'all' } } as PersistedUIState
    expect(migrateAutomationHostFilterSshTargetId(all, OLD_ID, NEW_ID)).toBe(false)
    const selfKey = hostStableKey({
      authority: { kind: 'desktop' },
      selector: { kind: 'self' }
    })
    expect(migrateAutomationHostFilterSshTargetId(uiWithFilter(selfKey), OLD_ID, NEW_ID)).toBe(
      false
    )
    expect(migrateAutomationHostFilterSshTargetId(uiWithFilter('garbage'), OLD_ID, NEW_ID)).toBe(
      false
    )
    // A store written before the filter existed must migrate without throwing.
    expect(migrateAutomationHostFilterSshTargetId({} as PersistedUIState, OLD_ID, NEW_ID)).toBe(
      false
    )
  })
})
