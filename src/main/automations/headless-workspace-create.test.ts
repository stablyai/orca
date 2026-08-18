import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'

const repoPath = path.join('tmp', 'orca')

const repo: Repo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git',
  executionHostId: 'ssh:ssh-target-1'
}

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly review',
  prompt: 'Review changes',
  precheck: null,
  agentId: 'codex',
  runContext: {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'ssh:ssh-target-1',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    path: repoPath
  },
  sourceContext: null,
  projectId: 'legacy-repo-1',
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-target-1',
  schedulerOwner: 'remote_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: 'origin/main',
  setupDecision: 'skip',
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1,
  enabled: true,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1
}

describe('headless automation workspace create args', () => {
  it('stamps automation provenance for serve-mode new-per-run workspaces', () => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation,
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo,
      createdAt: 123
    })

    expect(args).toMatchObject({
      repoSelector: 'repo-1',
      name: 'auto-nightly-review-run-20260102T0304',
      baseBranch: 'origin/main',
      setupDecision: 'skip',
      activate: false,
      createdWithAgent: 'codex',
      startupAgent: 'codex',
      startupPrompt: 'Review changes',
      telemetrySource: 'unknown',
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'automation-1',
        automationNameSnapshot: 'Nightly review',
        automationRunId: 'run-1',
        automationRunTitleSnapshot: 'Nightly review run',
        createdAt: 123,
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-target-1',
        projectId: 'project-1',
        repoId: 'repo-1',
        hostId: 'ssh:ssh-target-1'
      }
    })
  })

  it('falls back to skip for legacy automations without a saved setup decision', () => {
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, setupDecision: undefined },
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo
    })

    expect(args.setupDecision).toBe('skip')
  })

  it('links the exact external task when creating a new workspace', () => {
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'github:aprudkin/aimem',
      hostId: 'local' as const,
      providerIdentity: { provider: 'github' as const, owner: 'aprudkin', repo: 'aimem' }
    }
    const linkedTask = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 814,
      title: 'Disposable routing probe',
      url: 'https://github.com/aprudkin/aimem/issues/814'
    }
    const newerTask = {
      ...linkedTask,
      number: 815,
      url: 'https://github.com/aprudkin/aimem/issues/815'
    }
    const args = buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, sourceContext, linkedTask: newerTask },
      run: {
        id: 'run-1',
        title: 'Task review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5),
        sourceContext,
        linkedTask
      },
      repo
    })

    expect(args.linkedWorkItem).toEqual(linkedTask)
    expect(args.linkedTaskSourceContext).toEqual(sourceContext)
  })
})
