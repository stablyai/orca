import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { hashOrcaHookTrustContent } from '../workspace-hooks/created-worktree-setup-trust'
import { automationRunSetupSkip } from './automation-run-setup-skip'

const repo: Repo = { id: 'repo', path: '/primary', displayName: 'repo', badgeColor: '', addedAt: 0 }
let worktreePath: string
const runtime = { showManagedWorktree: vi.fn() }

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'orca-automation-setup-skip-'))
  writeFileSync(join(worktreePath, 'orca.yaml'), 'scripts:\n  setup: pnpm install && pnpm build\n')
  runtime.showManagedWorktree
    .mockReset()
    .mockResolvedValue({ id: 'ws', repoId: 'repo', path: worktreePath })
})

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true })
})

const approvedFor = (setup: string) =>
  ({
    workspaceMode: 'new_per_run',
    setupDecision: 'run',
    setupTrustHash: hashOrcaHookTrustContent(setup)
  }) as const

describe('automation run setup skip note', () => {
  it("notes a run whose branch's setup differs from the approved content", async () => {
    await expect(
      automationRunSetupSkip(runtime, approvedFor('pnpm install'), repo, 'ws')
    ).resolves.toEqual({ setupSkippedReason: 'setup-changed' })
    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:ws')
  })

  it('notes nothing when the branch matches', async () => {
    await expect(
      automationRunSetupSkip(runtime, approvedFor('pnpm install && pnpm build'), repo, 'ws')
    ).resolves.toEqual({})
  })

  it('does not look at automations saved without a hash or that reuse a workspace', async () => {
    await expect(
      automationRunSetupSkip(
        runtime,
        { workspaceMode: 'new_per_run', setupDecision: 'run' },
        repo,
        'ws'
      )
    ).resolves.toEqual({})
    await expect(
      automationRunSetupSkip(
        runtime,
        { ...approvedFor('pnpm install'), workspaceMode: 'existing' },
        repo,
        'ws'
      )
    ).resolves.toEqual({})
    expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
  })

  it('notes nothing when the workspace cannot be read', async () => {
    runtime.showManagedWorktree.mockRejectedValue(new Error('gone'))
    await expect(
      automationRunSetupSkip(runtime, approvedFor('pnpm install'), repo, 'ws')
    ).resolves.toEqual({})
  })
})
