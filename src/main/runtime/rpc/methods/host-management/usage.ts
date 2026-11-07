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

// Why: the stores scan transcripts on this Mac's disk (~/.claude/projects is 20+ GB), so the phone
// can only read the aggregates the desktop already built. Startup hands them over in register-core-handlers.
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
