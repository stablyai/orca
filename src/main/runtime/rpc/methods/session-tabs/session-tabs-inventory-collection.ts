import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../../shared/session-tabs-runtime-capabilities'
import { projectSessionTabsForClient } from './session-tabs-client-projection'
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

export function clientUnderstandsAuthoritativeInventory(context: RpcContext): boolean {
  return (
    context.clientCapabilities?.includes(
      SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY
    ) === true
  )
}

function projectInventory(
  inventory: SessionTabsInventory,
  context: RpcContext
): SessionTabsInventory {
  return {
    snapshots: inventory.snapshots.map((snapshot) =>
      projectSessionTabsForClient(snapshot, context.clientKind, context.clientCapabilities)
    ),
    ...(inventory.authoritative && clientUnderstandsAuthoritativeInventory(context)
      ? { authoritative: true as const }
      : {})
  }
}

export async function listSessionTabsInventory(context: RpcContext): Promise<SessionTabsInventory> {
  const result = projectInventory((await collectSessionTabsInventory(context)).inventory, context)
  if (context.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  context.runtime.observeClientHostedPageSnapshots?.(result.snapshots, context.pairedDeviceId)
  return result
}
