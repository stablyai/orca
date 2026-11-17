import { expect, it } from 'vitest'
import { startRuntimeLocalBaseRefRefresh } from './runtime-local-git-worktree-create'
import { createWorktreeCreateTimingRecorder } from '../../../workspaces/creation/worktree-create-timing'

it('refuses a cached remote baseline when its deferred refresh failed', async () => {
  const refresh = startRuntimeLocalBaseRefRefresh({
    repoPath: '/repo',
    base: {
      baseBranch: 'origin/main',
      remoteTrackingBase: {
        base: 'origin/main',
        ref: 'refs/remotes/origin/main',
        remote: 'origin',
        branch: 'main'
      },
      deferredRefresh: 'tracking_ref'
    },
    localWorktreeGitOptions: {},
    refreshRemoteTrackingBase: async () => ({ ok: false, errorKind: 'git_error' }),
    fetchRemote: async () => {},
    timing: createWorktreeCreateTimingRecorder()
  })
  await expect(refresh.finish()).rejects.toThrow(
    'Could not refresh base ref "origin/main" from "origin".'
  )
})
