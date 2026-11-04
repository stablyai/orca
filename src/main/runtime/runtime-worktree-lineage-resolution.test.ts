import { describe, expect, it } from 'vitest'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { resolveRuntimeWorktreeCreateLineage } from './runtime-worktree-lineage-resolution'

const unused = async (): Promise<never> => {
  throw new Error('not reached')
}

describe('resolveRuntimeWorktreeCreateLineage', () => {
  it('records an app-picked parent on another machine as manual', async () => {
    const parent = {
      installationId: 'mac-install',
      workspaceKey: worktreeWorkspaceKey('repo::/src/parent'),
      instanceId: 'parent-instance'
    }

    await expect(
      resolveRuntimeWorktreeCreateLineage(
        { crossStoreParent: parent, parentWorkspaceOrigin: 'manual' },
        {
          resolveParent: unused,
          resolveWorktreeParent: unused,
          resolveTaskCandidate: unused,
          resolveCaller: unused
        }
      )
    ).resolves.toEqual({
      kind: 'crossStore',
      parent,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' }
    })
  })
})
