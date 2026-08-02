import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/types'
import type * as GitStatusModule from '../git/status'
import type * as CommitMessageTextGenerationModule from '../text-generation/commit-message-text-generation'
import type * as WorktreeModule from '../git/worktree'
import { OrcaRuntimeService } from './orca-runtime'

const mocks = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
  getStagedCommitContext: vi.fn(),
  generateCommitMessageFromContext: vi.fn(),
  resolveCommitMessageSettings: vi.fn()
}))

vi.mock('../git/worktree', async () => ({
  ...(await vi.importActual<typeof WorktreeModule>('../git/worktree')),
  listWorktrees: mocks.listWorktrees
}))

vi.mock('../git/status', async () => ({
  ...(await vi.importActual<typeof GitStatusModule>('../git/status')),
  getStagedCommitContext: mocks.getStagedCommitContext
}))

vi.mock('../text-generation/commit-message-text-generation', async () => ({
  ...(await vi.importActual<typeof CommitMessageTextGenerationModule>(
    '../text-generation/commit-message-text-generation'
  )),
  generateCommitMessageFromContext: mocks.generateCommitMessageFromContext,
  resolveCommitMessageSettings: mocks.resolveCommitMessageSettings
}))

const REPO_ID = 'repo-1'
const STAGED_CONTEXT = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
const PARAMS = { agentId: 'codex', model: 'gpt-5.4-mini' }

const tempDirs: string[] = []

/**
 * Store double narrow enough to drive worktree resolution, so the runtime runs
 * its real hydration (`listResolvedWorktrees` → `mergeWorktree` → cache) instead
 * of a hand-built worktree fixture carrying `linkedIssue`.
 */
function makeStore(worktreePath: string) {
  const worktreeId = `${REPO_ID}::${worktreePath}`
  const worktreeMeta: Record<string, WorktreeMeta> = {
    [worktreeId]: {
      instanceId: worktreeId,
      displayName: 'wt',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }
  return {
    worktreeId,
    updateLinkedIssue: (linkedIssue: number | null): void => {
      // Why: mirrors `worktrees:updateMeta`, which persists the link without
      // invalidating the runtime's resolved-worktree cache.
      worktreeMeta[worktreeId] = { ...worktreeMeta[worktreeId], linkedIssue }
    },
    store: {
      getRepos: () => [
        { id: REPO_ID, path: worktreePath, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
      ],
      getRepo: (id: string) =>
        id === REPO_ID
          ? { id: REPO_ID, path: worktreePath, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
          : undefined,
      getAllWorktreeMeta: () => worktreeMeta,
      getWorktreeMeta: (id: string) => worktreeMeta[id],
      setWorktreeMeta: (id: string, updates: Partial<WorktreeMeta>) => {
        worktreeMeta[id] = { ...worktreeMeta[id], ...updates }
        return worktreeMeta[id]
      },
      getSettings: () => ({})
    }
  }
}

async function generatedCommitContext(
  runtime: OrcaRuntimeService,
  worktreeId: string
): Promise<Record<string, unknown>> {
  mocks.generateCommitMessageFromContext.mockClear()
  await runtime.generateRuntimeCommitMessage(`id:${worktreeId}`)
  return mocks.generateCommitMessageFromContext.mock.calls[0][0]
}

describe('runtime commit-message generation linked-issue freshness', () => {
  beforeEach(() => {
    mocks.listWorktrees.mockReset()
    mocks.getStagedCommitContext.mockReset()
    mocks.generateCommitMessageFromContext.mockReset()
    mocks.resolveCommitMessageSettings.mockReset()
    mocks.getStagedCommitContext.mockResolvedValue(STAGED_CONTEXT)
    mocks.generateCommitMessageFromContext.mockResolvedValue({ success: true, message: 'docs' })
    mocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params: PARAMS })
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('substitutes the linked issue persisted since the last worktree resolution', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-linked-issue-'))
    tempDirs.push(worktreePath)
    const { store, worktreeId, updateLinkedIssue } = makeStore(worktreePath)
    mocks.listWorktrees.mockResolvedValue([
      {
        path: worktreePath,
        head: 'a'.repeat(40),
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    const runtime = new OrcaRuntimeService(store as never)

    // Why: the first generation warms the resolved-worktree cache with the
    // unlinked projection, so a stale read would still answer `unlinked` below.
    expect(await generatedCommitContext(runtime, worktreeId)).not.toHaveProperty('linkedIssue')

    updateLinkedIssue(321)
    expect(await generatedCommitContext(runtime, worktreeId)).toMatchObject({ linkedIssue: 321 })

    updateLinkedIssue(null)
    expect(await generatedCommitContext(runtime, worktreeId)).not.toHaveProperty('linkedIssue')
  })
})
