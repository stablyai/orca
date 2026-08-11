import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'shared-repo'
const SSH_TARGET_ID = 'builder'

function repo(path: string, connectionId: string | null): Repo {
  return {
    id: REPO_ID,
    path,
    displayName: connectionId ? 'SSH repo' : 'Local repo',
    badgeColor: '#737373',
    addedAt: 1,
    connectionId
  }
}

describe('runtime project-group move ownership', () => {
  it('preserves the exact repo owner selected by path', async () => {
    const localRepo = repo('/local/repo', null)
    const sshRepo = repo('/remote/repo', SSH_TARGET_ID)
    const moveProjectToGroup = vi.fn(
      (
        repoId: string,
        groupId: string | null,
        order?: number,
        options: { executionHostId?: ExecutionHostId } = {}
      ) => {
        const match = [localRepo, sshRepo].find(
          (candidate) =>
            candidate.id === repoId &&
            (candidate.connectionId ? toSshExecutionHostId(candidate.connectionId) : 'local') ===
              options.executionHostId
        )
        return match ? { ...match, projectGroupId: groupId, projectGroupOrder: order } : null
      }
    )
    const runtime = new OrcaRuntimeService({
      getRepos: () => [localRepo, sshRepo],
      moveProjectToGroup
    } as never)

    await expect(
      runtime.moveProjectToGroup('path:/remote/repo', 'target-group', 4)
    ).resolves.toEqual(
      expect.objectContaining({
        path: '/remote/repo',
        connectionId: SSH_TARGET_ID,
        projectGroupId: 'target-group'
      })
    )
    expect(moveProjectToGroup).toHaveBeenCalledWith(REPO_ID, 'target-group', 4, {
      executionHostId: toSshExecutionHostId(SSH_TARGET_ID)
    })
  })
})
