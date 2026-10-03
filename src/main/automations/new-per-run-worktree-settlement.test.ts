import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { createNewPerRunWorktreeSettlement } from './new-per-run-worktree-settlement'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Patrol',
    prompt: 'Inspect',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: 'main',
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=HOURLY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Patrol',
    scheduledFor: 10,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: 'wt-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 10,
    dispatchedAt: 11,
    createdAt: 10,
    ...overrides
  }
}

function meta(runId: string, createdAt: number): WorktreeMeta {
  return {
    displayName: runId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: createdAt,
    hostId: 'local',
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'auto-1',
      automationNameSnapshot: 'Patrol',
      automationRunId: runId,
      automationRunTitleSnapshot: 'Patrol',
      createdAt,
      executionTargetType: 'local',
      executionTargetId: 'local',
      projectId: 'repo-1',
      hostId: 'local'
    }
  }
}

describe('new-per-run worktree settlement', () => {
  it('marks a clean success completed and removes it through the managed worktree API', async () => {
    const stored = { 'wt-1': meta('run-1', 10) }
    const statuses: string[] = []
    const removed: string[] = []
    const settlement = createNewPerRunWorktreeSettlement({
      store: {
        listAutomations: () => [automation()],
        listAutomationRuns: () => [run()],
        getRepo: () => ({
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#fff',
          addedAt: 1
        }),
        getAllWorktreeMeta: () => stored,
        setWorktreeMeta: (id, patch) => {
          stored[id] = { ...stored[id], ...patch }
          if (patch.workspaceStatus) {
            statuses.push(patch.workspaceStatus)
          }
          return stored[id]!
        },
        setWorktreeMetaForHost: (id, _host, patch) => {
          stored[id] = { ...stored[id], ...patch, hostId: 'local' }
          if (patch.workspaceStatus) {
            statuses.push(patch.workspaceStatus)
          }
          return stored[id]!
        }
      },
      runtime: {
        listManagedWorktrees: async () => ({
          truncated: false,
          worktrees: [
            {
              id: 'wt-1',
              path: '/repo-wt',
              hostId: 'local',
              isMainWorktree: false,
              baseRef: 'main',
              automationProvenance: stored['wt-1']?.automationProvenance
            }
          ]
        }),
        removeManagedWorktree: async (selector) => {
          removed.push(selector)
        }
      },
      localGitOptionsForRepo: () => ({}),
      inspectGitSafety: async () => 'reclaimable'
    })

    await settlement.settle(run())

    expect(statuses).toEqual(['completed'])
    expect(removed).toEqual(['id:wt-1'])
    expect(removed[0]).not.toContain('git worktree')
  })

  it('marks a failed run failed and does not remove a dirty worktree', async () => {
    const stored = { 'wt-1': meta('run-1', 10) }
    const removed: string[] = []
    let status = ''
    const settlement = createNewPerRunWorktreeSettlement({
      store: {
        listAutomations: () => [automation()],
        listAutomationRuns: () => [run({ status: 'dispatch_failed' })],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => stored,
        setWorktreeMeta: (id, patch) => {
          status = patch.workspaceStatus ?? status
          return stored[id]!
        }
      },
      runtime: {
        listManagedWorktrees: async () => ({
          truncated: false,
          worktrees: [
            {
              id: 'wt-1',
              path: '/repo-wt',
              hostId: 'local',
              isMainWorktree: false,
              automationProvenance: stored['wt-1']?.automationProvenance
            }
          ]
        }),
        removeManagedWorktree: async (selector) => {
          removed.push(selector)
        }
      },
      inspectGitSafety: async () => 'keep'
    })

    await settlement.settle(run({ status: 'dispatch_failed', error: 'boom' }))

    expect(status).toBe('failed')
    expect(removed).toEqual([])
  })

  it('does not touch an existing-workspace automation or a worktree from another run', async () => {
    let writes = 0
    const settlement = createNewPerRunWorktreeSettlement({
      store: {
        listAutomations: () => [automation({ workspaceMode: 'existing', workspaceId: 'wt-user' })],
        listAutomationRuns: () => [],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        setWorktreeMeta: () => {
          writes += 1
          return meta('run-1', 1)
        }
      },
      runtime: {
        listManagedWorktrees: async () => ({ truncated: false, worktrees: [] }),
        removeManagedWorktree: async () => undefined
      }
    })
    await settlement.settle(run({ workspaceId: 'wt-user' }))
    const mismatched = createNewPerRunWorktreeSettlement({
      store: {
        listAutomations: () => [automation()],
        listAutomationRuns: () => [run()],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({ 'wt-1': meta('other-run', 1) }),
        setWorktreeMeta: () => {
          writes += 1
          return meta('other-run', 1)
        }
      },
      runtime: {
        listManagedWorktrees: async () => ({ truncated: false, worktrees: [] }),
        removeManagedWorktree: async () => undefined
      }
    })
    await mismatched.settle(run())
    expect(writes).toBe(0)
  })
})
