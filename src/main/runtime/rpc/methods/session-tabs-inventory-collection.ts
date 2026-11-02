import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'

export type SessionTabsInventory = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative?: true
}

export async function collectSessionTabsInventory(
  context: RpcContext,
  includeChangeSequence = false
): Promise<{
  inventory: SessionTabsInventory
  changeSequence: number
}> {
  const { runtime, pairedDeviceId, signal } = context
  // Census failure reuses its scan without authority, never collecting twice.
  if (!includeChangeSequence) {
    const inventory = runtime.supportsAuthoritativeSessionTabsInventory()
      ? await runtime.listAllMobileSessionTabsInventory(pairedDeviceId, signal)
      : { snapshots: await runtime.listAllMobileSessionTabs(pairedDeviceId) }
    return { inventory, changeSequence: 0 }
  }
  const collected = runtime.supportsAuthoritativeSessionTabsInventory()
    ? await runtime.listAllMobileSessionTabsInventoryWithChangeSequence(pairedDeviceId, signal)
    : await runtime.listAllMobileSessionTabsWithChangeSequence(pairedDeviceId)
  return {
    inventory: collected,
    changeSequence: collected.changeSequence
  }
}
