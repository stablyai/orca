import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
  it('stamps automation provenance for serve-mode new-per-run workspaces', async () => {
    const args = await buildHeadlessAutomationWorktreeCreateArgs({
      automation,
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo,
      createdAt: 123,
      hasRemoteTrackingRef: async () => true
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

  it('falls back to skip for legacy automations without a saved setup decision', async () => {
    const args = await buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, setupDecision: undefined },
      run: {
        id: 'run-1',
        title: 'Nightly review run',
        scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5)
      },
      repo,
      hasRemoteTrackingRef: async () => false
    })

    expect(args.setupDecision).toBe('skip')
  })

  it('starts a bare base from its remote-tracking ref when one exists', async () => {
    const hasRemoteTrackingRef = vi.fn(async (ref: string) => ref === 'origin/main')
    const args = await buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, baseBranch: 'main' },
      run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 1 },
      repo,
      hasRemoteTrackingRef
    })

    expect(args.baseBranch).toBe('origin/main')
    expect(hasRemoteTrackingRef).toHaveBeenCalledWith('origin/main')
  })

  it('keeps a local-only base branch when no remote-tracking ref exists', async () => {
    const args = await buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, baseBranch: 'feature' },
      run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 1 },
      repo,
      hasRemoteTrackingRef: async () => false
    })

    expect(args.baseBranch).toBe('feature')
  })

  it('leaves an unset base to the project default without probing', async () => {
    const hasRemoteTrackingRef = vi.fn(async () => true)
    const args = await buildHeadlessAutomationWorktreeCreateArgs({
      automation: { ...automation, baseBranch: null },
      run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 1 },
      repo,
      hasRemoteTrackingRef
    })

    expect(args.baseBranch).toBeUndefined()
    expect(hasRemoteTrackingRef).not.toHaveBeenCalled()
  })
})
