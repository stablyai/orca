import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/repo-types'

export function registerOrcaRuntimeAutomationsTests(): void {
  const repo: Repo = {
    id: 'repo-1',
    path: '/tmp/orca',
    displayName: 'orca',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git'
  }

  function makeStore(existingAutomations: Automation[] = []) {
    return {
      getRepos: vi.fn(() => [repo]),
      createAutomation: vi.fn((input) => ({
        id: 'auto-1',
        executionTargetType: 'local',
        executionTargetId: 'local',
        schedulerOwner: 'local_host_service',
        nextRunAt: 2,
        missedRunPolicy: 'run_once_within_grace',
        createdAt: 1,
        updatedAt: 1,
        ...input
      })),
      listAutomations: vi.fn(() => existingAutomations),
      listAutomationRuns: vi.fn(() => []),
      updateAutomation: vi.fn((id, updates) => ({ ...existingAutomations[0], id, ...updates })),
      deleteAutomation: vi.fn(),
      getSettings: vi.fn(() => ({
        workspaceDir: '/tmp',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: '',
        branchPrefixCustom: ''
      })),
      getAllWorktreeMeta: vi.fn(() => new Map()),
      getWorktreeMeta: vi.fn(),
      setWorktreeMeta: vi.fn(),
      removeWorktreeMeta: vi.fn(),
      getGitHubCache: vi.fn()
    }
  }

  const existingAutomation = {
    id: 'auto-1',
    name: 'Daily review',
    prompt: 'Review changes',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: 'main',
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1
  } satisfies Automation

  describe('OrcaRuntimeService automation methods', () => {
    it('rejects a run context that names a different repo path', async () => {
      const store = makeStore()
      const runtime = new OrcaRuntimeService(store as never)

      await expect(
        runtime.createAutomation({
          name: 'Mismatched review',
          prompt: 'Review changes',
          agentId: 'codex',
          repo: 'id:repo-1',
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/other/repo'
          },
          workspaceMode: 'new_per_run',
          setupDecision: 'skip',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1
        })
      ).rejects.toThrow('Automation project does not match its run context.')
      expect(store.createAutomation).not.toHaveBeenCalled()
    })

    it('rejects a run-context-only update that names a different repo path', async () => {
      const store = makeStore([existingAutomation])
      const runtime = new OrcaRuntimeService(store as never)

      await expect(
        runtime.updateAutomation('auto-1', {
          runContext: {
            kind: 'workspace-run',
            projectId: 'project-1',
            hostId: 'local',
            projectHostSetupId: 'setup-1',
            repoId: 'repo-1',
            path: '/other/repo'
          }
        })
      ).rejects.toThrow('Automation project does not match its run context.')
      expect(store.updateAutomation).not.toHaveBeenCalled()
    })
  })
}
