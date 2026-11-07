import { defineMethod } from '../../core'
import {
  UsageSnapshotParams,
  type UsageSnapshotProvider
} from '../../../../../shared/rpc-contract/usage-params'

type UsageSnapshotStore = {
  whenLoaded: () => Promise<void>
  getSnapshot: (
    scope: 'orca' | 'all',
    range: '7d' | '30d' | '90d' | 'all',
    limit?: number
  ) => unknown
}

// Why: the stores scan transcripts on this Mac's disk (transcript folders can run to tens of GB), so the phone
// can only read the aggregates the desktop already built. registerUsageProviderHandlers (ipc/usage-provider-handlers.ts) hands them over at startup.
let usageStores: Record<UsageSnapshotProvider, UsageSnapshotStore> | null = null

export function setUsageSnapshotStores(
  stores: Record<UsageSnapshotProvider, UsageSnapshotStore>
): void {
  usageStores = stores
}

export const USAGE_METHODS = [
  defineMethod({
    name: 'usage.snapshot',
    permission: 'workspace',
    params: UsageSnapshotParams,
    handler: async (params) => {
      if (!usageStores) {
        throw new Error('usage_unavailable')
      }
      const store = usageStores[params.provider]
      // Wait for worker hydration so the reply is not persisted-state defaults.
      await store.whenLoaded()
      return store.getSnapshot(params.scope, params.range, params.limit)
    }
  })
]
