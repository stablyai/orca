import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import {
  __resetDetectedWorktreeScanCacheForTests,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'

function createStore(): Store {
  return {
    getProjects: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

describe('detected worktree scan during transient path loss', () => {
  beforeEach(() => {
    __resetDetectedWorktreeScanCacheForTests()
  })

  it('keeps an unreachable local repo scan non-authoritative', async () => {
    const repo: Repo = {
      id: 'repo-1',
      path: join(tmpdir(), `orca-unreachable-repo-${randomUUID()}`),
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
    }

    await expect(listDetectedGitWorktrees(createStore(), repo)).rejects.toThrow()
  })
})
