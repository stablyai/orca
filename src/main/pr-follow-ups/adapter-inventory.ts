import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

export function subscribeFollowUpInventory(
  runtime: OrcaRuntimeService,
  store: RuntimeStore,
  catalog: { load(): Promise<unknown> },
  changed: () => void
): () => void {
  let disposed = false
  const load = (): void => {
    if (
      !store.getRepos().some((repo) => {
        const settings = resolvePrFollowUps(store.getSettings().prFollowUps, repo.prFollowUps)
        return settings.enabled && settings.ciFailed === 'new-agent'
      })
    ) {
      return
    }
    // Branches must be known even when no client has listed workspaces yet.
    void catalog
      .load()
      .then(() => {
        if (!disposed) {
          changed()
        }
      })
      .catch((error: unknown) => console.error('[pr-follow-ups] workspace inventory failed', error))
  }
  const releaseStore = store.onStateWritten?.(changed)
  const releaseSettings = store.onSettingsChanged?.((updates) => {
    if ('prFollowUps' in updates) {
      load()
    }
  })
  const releaseClient = runtime.onClientEvent(
    (event) => {
      if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
        changed()
      }
      if (event.type === 'reposChanged') {
        load()
      }
    },
    { consumesTerminalSideEffects: false }
  )
  load()
  return () => {
    disposed = true
    releaseStore?.()
    releaseSettings?.()
    releaseClient()
  }
}
