import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../construction/test-context/runtime-store-partial-fixture'
import * as enrichment from '../../../workspaces/catalog/repo-git-remote-identity-enrichment'

afterEach(() => vi.restoreAllMocks())

// #45148: catalog discovery must not accumulate completion subscriptions during a stalled sweep.
it('repeated list reads retain one completion callback per runtime and invalidate after convergence', () => {
  const callbacks = new Set<() => void>()
  vi.spyOn(enrichment, 'enrichMissingRepoGitRemoteIdentities').mockImplementation(
    (_store, options) => {
      if (options?.onChanged) {
        callbacks.add(options.onChanged)
      }
    }
  )
  const runtime = new OrcaRuntimeService(partialRuntimeStore())
  const invalidate = vi.spyOn(runtime, 'invalidateResolvedWorktreeCache')
  const events: string[] = []
  const unsubscribe = runtime.onClientEvent((event) => events.push(event.type))
  for (let index = 0; index < 200; index++) {
    runtime.enrichMissingRepoGitRemoteIdentities()
  }
  expect(callbacks.size).toBe(1)
  for (const callback of callbacks) {
    callback()
  }
  expect(invalidate).toHaveBeenCalledTimes(1)
  expect(events).toContain('reposChanged')
  unsubscribe()
})
