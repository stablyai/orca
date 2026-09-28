import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { ptyOwnership } from './ownership-state'
import { registeredPtyProviders, tryGetProviderForPty } from './registry'

export type LocalInventoryAuthorityDeps = {
  store?: Pick<Store, 'getWorkspaceSession'>
  runtime?: Pick<OrcaRuntimeService, 'markPtyLivenessUnverifiable'>
}

/** Persisted bindings still name an owner when its connector has left the registry. */
export function createLocalInventoryAuthority(deps: LocalInventoryAuthorityDeps) {
  const known = new Set(ptyOwnership.keys())
  const session = deps.store?.getWorkspaceSession()
  for (const tabs of Object.values(session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.ptyId) {
        known.add(tab.ptyId)
      }
    }
  }
  for (const id of Object.values(session?.remoteSessionIdsByTabId ?? {})) {
    if (id) {
      known.add(id)
    }
  }
  for (const layout of Object.values(session?.terminalLayoutsByTabId ?? {})) {
    for (const id of Object.values(layout.ptyIdsByLeafId ?? {})) {
      if (id) {
        known.add(id)
      }
    }
  }
  const guestIds = [...known].filter((id) => id.startsWith('wsl:'))
  const owners = new Map(guestIds.map((id) => [id, tryGetProviderForPty(id)]))
  const localProviders = () =>
    new Set(
      registeredPtyProviders()
        .filter((entry) => entry.connectionId === null)
        .map((entry) => entry.provider)
    )
  const providers = localProviders()
  let complete = true
  const mark = (id: string, reason: string) => {
    complete = false
    deps.runtime?.markPtyLivenessUnverifiable?.(id, reason)
  }
  for (const [id, provider] of owners) {
    if (!provider) {
      mark(id, 'WSL terminal owner is not connected')
    }
  }
  const isComplete = () => {
    const current = localProviders()
    if (
      current.size !== providers.size ||
      [...providers].some((provider) => !current.has(provider))
    ) {
      complete = false
    }
    for (const [id, provider] of owners) {
      if (provider !== tryGetProviderForPty(id)) {
        mark(id, 'WSL terminal owner changed during inventory')
      }
    }
    return complete
  }
  return {
    failed(provider: IPtyProvider, error: unknown) {
      complete = false
      const reason = error instanceof Error ? error.message : String(error)
      for (const id of guestIds) {
        if (owners.get(id) === provider) {
          mark(id, reason)
        }
      }
    },
    isComplete,
    assertComplete() {
      if (!isComplete()) {
        throw new Error('Local terminal inventory is unverifiable: a WSL owner is unavailable')
      }
    }
  }
}
