import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { RpcContext } from '../../core'

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
  const delivery = { includeAgentSenders: context.clientKind !== 'mobile' }
  // Census failure reuses its scan without authority, never collecting twice.
  if (!includeChangeSequence) {
    const inventory = runtime.supportsAuthoritativeSessionTabsInventory()
      ? await runtime.listAllMobileSessionTabsInventory(pairedDeviceId, signal, delivery)
      : { snapshots: await runtime.listAllMobileSessionTabs(pairedDeviceId, delivery) }
    return { inventory, changeSequence: 0 }
  }
  const collected = runtime.supportsAuthoritativeSessionTabsInventory()
    ? await runtime.listAllMobileSessionTabsInventoryWithChangeSequence(
        pairedDeviceId,
        signal,
        delivery
      )
    : await runtime.listAllMobileSessionTabsWithChangeSequence(pairedDeviceId, delivery)
  return {
    inventory: collected,
    changeSequence: collected.changeSequence
  }
}
