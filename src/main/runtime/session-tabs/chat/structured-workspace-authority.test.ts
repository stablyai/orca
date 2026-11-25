import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  prepareStructuredWorkspaceAuthority,
  StructuredWorkspaceUnavailable
} from './structured-workspace-authority'

function storeWithRepos(repos: Repo[]): RuntimeStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a missing owner is decided from repo rows alone.
  return { getRepos: () => repos } as unknown as RuntimeStore
}

async function revealFailure(store: RuntimeStore) {
  const error = await prepareStructuredWorkspaceAuthority(
    store,
    {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'repo-1::/work/app',
      workspaceKind: 'git-worktree'
    },
    () => Promise.reject(new Error('unreachable'))
  ).catch((caught: unknown) => caught)
  if (!(error instanceof StructuredWorkspaceUnavailable)) {
    throw new Error(`expected a workspace refusal, got ${String(error)}`)
  }
  return { reason: error.reason, workspaceKind: error.workspaceKind }
}

describe('prepareStructuredWorkspaceAuthority', () => {
  it('reports a project no host registers as removed, not as retry-later', async () => {
    expect(await revealFailure(storeWithRepos([]))).toEqual({
      reason: 'removed',
      workspaceKind: 'project'
    })
  })

  it('keeps an unresolved owner retryable while another host still registers the repo', async () => {
    const sshTwin: Repo = {
      id: 'repo-1',
      path: '/work/app',
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'box'
    }
    expect(await revealFailure(storeWithRepos([sshTwin]))).toEqual({
      reason: 'unknown',
      workspaceKind: undefined
    })
  })
})
