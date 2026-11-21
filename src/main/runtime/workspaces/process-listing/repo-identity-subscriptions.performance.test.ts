import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  partialRuntimeStore,
  storeRepo
} from '../../construction/test-context/runtime-store-partial-fixture'
import * as probing from '../../../workspaces/catalog/repo-git-remote-identity'
import type { GitRemoteIdentityProbe } from '../../../workspaces/catalog/repo-git-remote-identity'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// PR #45948: a stalled sweep used to accumulate one notification callback per catalog read.
it('repeated list reads publish one completion per runtime after the real sweep converges', async () => {
  vi.useFakeTimers()
  let completeProbe!: (result: GitRemoteIdentityProbe) => void
  vi.spyOn(probing, 'probeGitRemoteIdentity').mockReturnValue(
    new Promise((resolve) => {
      completeProbe = resolve
    })
  )
  const repo = storeRepo({ id: 'repo', path: '/catalog-subscription-repo' })
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [repo],
      getRepo: () => repo,
      updateRepo: (_target, updates) => Object.assign(repo, updates)
    })
  )
  const invalidate = vi.spyOn(runtime, 'invalidateResolvedWorktreeCache')
  const events: string[] = []
  let published!: () => void
  const completion = new Promise<void>((resolve) => {
    published = resolve
  })
  const unsubscribe = runtime.onClientEvent((event) => {
    events.push(event.type)
    if (event.type === 'reposChanged') {
      published()
    }
  })
  for (let index = 0; index < 200; index++) {
    runtime.enrichMissingRepoGitRemoteIdentities()
  }
  completeProbe({ status: 'no-remote' })
  await completion
  await vi.advanceTimersByTimeAsync(0)
  expect(invalidate).toHaveBeenCalledTimes(1)
  expect(events.filter((event) => event === 'reposChanged')).toHaveLength(1)
  expect(repo.gitRemoteIdentity).toBeNull()
  unsubscribe()
})
