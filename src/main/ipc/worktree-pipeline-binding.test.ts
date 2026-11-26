import { expect, it } from 'vitest'
import { mergeWorktree } from './worktrees/metadata/worktree-metadata-merge'
import { storeWorktreeMeta } from '../runtime/pipelines/testing/pipeline-runtime-store.test-fixture'

it('retains the pipeline association when reloading persisted worktree metadata', () => {
  const worktree = mergeWorktree(
    'repo',
    {
      path: '/project/task',
      head: 'a'.repeat(40),
      branch: 'refs/heads/task',
      isBare: false,
      isMainWorktree: false
    },
    storeWorktreeMeta({
      instanceId: 'instance',
      hostId: 'local',
      pipeline: {
        runId: 'run',
        profileId: 'samples.pipelines/standard',
        version: '1',
        digest: 'b'.repeat(64)
      }
    })
  )
  expect(worktree.pipeline).toEqual({
    runId: 'run',
    profileId: 'samples.pipelines/standard',
    version: '1',
    digest: 'b'.repeat(64)
  })
})
