import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'

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
  it('creates repo-scoped automations through the shared store', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    const automation = await runtime.createAutomation({
      name: 'Daily review',
      prompt: 'Review changes',
      precheck: { command: 'test -f ready', timeoutSeconds: 30 },
      agentId: 'codex',
      repo: 'repo-1',
      workspaceMode: 'new_per_run',
      setupDecision: 'skip',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: 1
    })

    expect(store.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Daily review',
        prompt: 'Review changes',
        precheck: { command: 'test -f ready', timeoutSeconds: 30 },
        agentId: 'codex',
        projectId: 'repo-1',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        setupDecision: 'skip'
      }),
      // Owner options are absent on an unfenced RPC create; the arg still rides.
      undefined
    )
    expect(automation.id).toBe('auto-1')
  })

  it('pins a validated model and effort on create', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.createAutomation({
      name: 'Nightly triage',
      prompt: 'Triage the backlog',
      agentId: 'claude',
      model: 'opus',
      effort: 'high',
      repo: 'repo-1',
      workspaceMode: 'new_per_run',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: 1
    })

    expect(store.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus', effort: 'high' }),
      undefined
    )
  })

  it('refuses a model for an agent with no launch-time model selection', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    await expect(
      runtime.createAutomation({
        name: 'Nightly triage',
        prompt: 'Triage the backlog',
        agentId: 'opencode',
        model: 'anything',
        repo: 'repo-1',
        workspaceMode: 'new_per_run',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    ).rejects.toThrow('Agent opencode does not support launch-time model selection.')
    expect(store.createAutomation).not.toHaveBeenCalled()
  })

  it('refuses an effort with no model to apply it to', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    await expect(
      runtime.createAutomation({
        name: 'Nightly triage',
        prompt: 'Triage the backlog',
        agentId: 'claude',
        effort: 'high',
        repo: 'repo-1',
        workspaceMode: 'new_per_run',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    ).rejects.toThrow('--effort requires --model.')
    expect(store.createAutomation).not.toHaveBeenCalled()
  })

  it('clears the pinned model and its effort on update', async () => {
    const store = makeStore([{ ...existingAutomation, model: 'opus', effort: 'high' }])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { model: null })

    expect(store.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { model: null, effort: null },
      undefined
    )
  })

  it('refuses an effort on an automation that is already unpinned, exactly as create does', async () => {
    const store = makeStore([{ ...existingAutomation, model: null, effort: null }])
    const runtime = new OrcaRuntimeService(store as never)

    await expect(runtime.updateAutomation('auto-1', { effort: 'high' })).rejects.toThrow(
      '--effort requires --model.'
    )
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

  it('keeps an effort edit against the model the automation already has pinned', async () => {
    const store = makeStore([{ ...existingAutomation, model: 'opus', effort: 'low' }])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { effort: 'high' })

    expect(store.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { model: 'opus', effort: 'high' },
      undefined
    )
  })

  it('revalidates a pinned model against a newly chosen provider', async () => {
    const store = makeStore([{ ...existingAutomation, model: 'opus', effort: 'high' }])
    const runtime = new OrcaRuntimeService(store as never)

    await expect(runtime.updateAutomation('auto-1', { agentId: 'opencode' })).rejects.toThrow(
      'Agent opencode does not support launch-time model selection.'
    )
    expect(store.updateAutomation).not.toHaveBeenCalled()
  })

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

  it('rejects a mismatched run context when the workspace is the machine selector', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo-1::/tmp/orca',
      repoId: 'repo-1',
      path: '/tmp/orca'
    } as never)

    await expect(
      runtime.createAutomation({
        name: 'Workspace review',
        prompt: 'Review changes',
        agentId: 'codex',
        workspace: 'id:repo-1::/tmp/orca',
        runContext: {
          kind: 'workspace-run',
          projectId: 'project-1',
          hostId: 'local',
          projectHostSetupId: 'setup-1',
          repoId: 'repo-1',
          path: '/other/repo'
        },
        workspaceMode: 'existing',
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

  it('updates and deletes existing automations through the shared store', async () => {
    const store = makeStore([existingAutomation])
    const runtime = new OrcaRuntimeService(store as never)

    const updated = await runtime.updateAutomation('auto-1', { enabled: false })
    const removed = runtime.deleteAutomation('auto-1')

    expect(store.updateAutomation).toHaveBeenCalledWith('auto-1', { enabled: false }, undefined)
    expect(updated).toMatchObject({
      prompt: existingAutomation.prompt,
      baseBranch: existingAutomation.baseBranch,
      workspaceMode: existingAutomation.workspaceMode,
      enabled: false
    })
    expect(store.deleteAutomation).toHaveBeenCalledWith('auto-1', undefined)
    expect(removed).toEqual({ removed: true, id: 'auto-1' })
  })

  it('preserves explicit nullable fields in sparse automation updates', async () => {
    const store = makeStore([existingAutomation])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { baseBranch: null })

    expect(store.updateAutomation).toHaveBeenCalledWith('auto-1', { baseBranch: null }, undefined)
  })

  it('passes setup decision updates through the shared store', async () => {
    const store = makeStore([existingAutomation])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { setupDecision: 'run' })

    expect(store.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { setupDecision: 'run' },
      undefined
    )
  })

  it('passes session reuse updates for existing-workspace automations', async () => {
    const existing = {
      ...existingAutomation,
      workspaceMode: 'existing',
      workspaceId: 'repo-1::/tmp/orca',
      baseBranch: null
    } satisfies Automation
    const store = makeStore([existing])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', { reuseSession: true })

    expect(store.updateAutomation).toHaveBeenCalledWith('auto-1', { reuseSession: true }, undefined)
  })

  it('clears session reuse when retargeting to new-per-run', async () => {
    const existing = {
      ...existingAutomation,
      workspaceMode: 'existing',
      workspaceId: 'repo-1::/tmp/orca',
      baseBranch: null,
      reuseSession: true
    } satisfies Automation
    const store = makeStore([existing])
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.updateAutomation('auto-1', {
      repo: 'repo-1',
      workspaceMode: 'new_per_run'
    })

    expect(store.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      expect.objectContaining({
        projectId: 'repo-1',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        reuseSession: false
      }),
      undefined
    )
  })

  it('rejects session reuse for new-per-run automations', async () => {
    const store = makeStore()
    const runtime = new OrcaRuntimeService(store as never)

    await expect(
      runtime.createAutomation({
        name: 'Fresh',
        prompt: 'Run checks',
        agentId: 'codex',
        repo: 'repo-1',
        workspaceMode: 'new_per_run',
        reuseSession: true,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1
      })
    ).rejects.toThrow('Session reuse requires an existing workspace target.')
    expect(store.createAutomation).not.toHaveBeenCalled()
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
