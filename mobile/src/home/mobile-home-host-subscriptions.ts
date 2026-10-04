import { decodeAccountsSnapshot } from '../components/AccountUsage'
import { getHostAccountEvidence } from '../accounts/host-account-evidence'
import { subscribeToDesktopNotifications } from '../notifications/mobile-notifications'
import { createHostConnectRefetchGate } from '../transport/host-connect-refetch-gate'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  fetchHomeHostWorktreeInfo,
  type HostWorktreeInfoSetter
} from '../worktree/home-host-worktree-fetch'
import {
  fetchMobileHomeStats,
  fetchMobileHomeTaskProviders,
  type HomeAccountsSetter,
  type HomeStatsSetter,
  type HomeTaskProvidersSetter
} from './mobile-home-host-requests'

export type MobileHomeHostSetters = {
  setStats: HomeStatsSetter
  setWorktreeInfo: HostWorktreeInfoSetter
  setAccounts: HomeAccountsSetter
  setTaskProviders: HomeTaskProvidersSetter
}

export function wireMobileHomeHostSubscriptions(
  entry: { hostId: string; client: RpcClient; state: ConnectionState },
  setters: MobileHomeHostSetters
): () => void {
  let unsubscribeNotifications: (() => void) | null = null
  let unsubscribeAccounts: (() => void) | null = null
  let disposed = false
  let accountEpoch = 0
  const accountEvidence = getHostAccountEvidence(entry.client, entry.hostId)
  let generation = entry.client.getGeneration?.()
  const refetchGate = createHostConnectRefetchGate()
  const retireAccounts = (): void => {
    accountEpoch += 1
    accountEvidence.retire()
    unsubscribeAccounts?.()
    unsubscribeAccounts = null
    setters.setAccounts((previous) => {
      if (!previous[entry.hostId]) {
        return previous
      }
      const next = { ...previous }
      delete next[entry.hostId]
      return next
    })
  }
  const wireState = (state: ConnectionState): void => {
    if (disposed) {
      return
    }
    const nextGeneration = entry.client.getGeneration?.()
    if (generation !== nextGeneration) {
      generation = nextGeneration
      retireAccounts()
    }
    const reconnected = refetchGate.observe(state)
    if (state === 'connected') {
      unsubscribeNotifications ??= subscribeToDesktopNotifications(entry.client, entry.hostId)
      if (!unsubscribeAccounts) {
        retireAccounts()
        const epoch = accountEpoch
        unsubscribeAccounts = entry.client.subscribe('accounts.subscribe', null, (payload) => {
          if (disposed || epoch !== accountEpoch || !payload || typeof payload !== 'object') {
            return
          }
          if (!('type' in payload) || (payload.type !== 'ready' && payload.type !== 'snapshot')) {
            return
          }
          accountEvidence.retire()
          try {
            const snapshot = decodeAccountsSnapshot(
              'snapshot' in payload ? payload.snapshot : undefined
            )
            setters.setAccounts((previous) => ({ ...previous, [entry.hostId]: snapshot }))
          } catch {
            setters.setAccounts((previous) => {
              const next = { ...previous }
              delete next[entry.hostId]
              return next
            })
          }
        })
      }
      if (reconnected) {
        fetchMobileHomeStats(entry.client, entry.hostId, setters.setStats, () => disposed)
        void fetchHomeHostWorktreeInfo(
          entry.client,
          entry.hostId,
          setters.setWorktreeInfo,
          () => disposed
        )
        fetchMobileHomeTaskProviders(
          entry.client,
          entry.hostId,
          setters.setTaskProviders,
          () => disposed
        )
      }
      return
    }
    unsubscribeNotifications?.()
    unsubscribeNotifications = null
    retireAccounts()
  }
  wireState(entry.state)
  const unsubscribeState = entry.client.onStateChange(wireState)
  return () => {
    disposed = true
    unsubscribeState()
    unsubscribeNotifications?.()
    retireAccounts()
  }
}
