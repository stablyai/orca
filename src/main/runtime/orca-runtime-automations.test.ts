import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/types'

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
  agentId: 'codex',
  projectId: 'repo-1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: 'main',
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
  it('creates repo-scoped automations through the shared store', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    const automation = await runtime.createAutomation({
      name: 'Daily review',
      prompt: 'Review changes',
      agentId: 'codex',
      repo: 'repo-1',
      workspaceMode: 'new_per_run',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: 1
    })

    expect(store.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Daily review',
        prompt: 'Review changes',
        agentId: 'codex',
        projectId: 'repo-1',
        workspaceMode: 'new_per_run',
        workspaceId: null
      })
    )
    expect(automation.id).toBe('auto-1')
  })

  it('updates and deletes existing automations through the shared store', async () => {
    const store = makeStore([existingAutomation])
    const runtime = new OrcaRuntimeService(store as never)

    const updated = await runtime.updateAutomation('auto-1', { enabled: false })
    const removed = runtime.deleteAutomation('auto-1')

    expect(store.updateAutomation).toHaveBeenCalledWith('auto-1', { enabled: false })
    expect(updated).toMatchObject({
      prompt: existingAutomation.prompt,
      baseBranch: existingAutomation.baseBranch,
      workspaceMode: existingAutomation.workspaceMode,
      enabled: false
    })
    expect(store.deleteAutomation).toHaveBeenCalledWith('auto-1')
    expect(removed).toEqual({ removed: true, id: 'auto-1' })
  })

  it('preserves explicit nullable fields in sparse automation updates', async () => {
    const store = makeStore([existingAutomation])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { baseBranch: null })

    expect(store.updateAutomation).toHaveBeenCalledWith('auto-1', { baseBranch: null })
  })

  it('rejects repo-only updates for existing-workspace automations', async () => {
    const existing = {
      ...existingAutomation,
      workspaceMode: 'existing',
      workspaceId: 'repo-1::/tmp/orca-worktree',
      baseBranch: null
    } satisfies Automation
    const store = makeStore([existing])
    const runtime = new OrcaRuntimeService(store as never)

    await expect(runtime.updateAutomation('auto-1', { repo: 'repo-2' })).rejects.toThrow(
      'Repo updates for existing-workspace automation require workspaceMode new_per_run.'
    )
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })
})
