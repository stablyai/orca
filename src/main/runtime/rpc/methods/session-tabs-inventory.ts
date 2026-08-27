import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'

type SessionTabsInventory = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative?: true
}

function clientUnderstandsAuthoritativeInventory(context: RpcContext): boolean {
  return (
    context.clientCapabilities?.includes(
      SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY
    ) === true
  )
}

export function projectSessionTabsForClient(
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabAgentStatus>[2]
): RuntimeMobileSessionTabsResult {
  return projectSessionTabBrowserPlacements(
    projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities),
    clientCapabilities
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
  const { runtime, pairedDeviceId, signal } = context
  const collectInventory = async (): Promise<SessionTabsInventory> =>
    runtime.supportsAuthoritativeSessionTabsInventory()
      ? await runtime.listAllMobileSessionTabsInventory(pairedDeviceId, signal)
      : { snapshots: await runtime.listAllMobileSessionTabs(pairedDeviceId) }
  try {
    return projectInventory(await collectInventory(), context)
  } catch (error) {
    // Why: a census failure only invalidates the emptiness verdict, so every
    // client gets the best-effort list unlabeled — capable clients then gate
    // empty results behind their liveness probe instead of losing the list.
    if (!(error instanceof Error && error.message === 'terminal_liveness_unavailable')) {
      throw error
    }
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
    return projectInventory(
      { snapshots: await runtime.listAllMobileSessionTabs(pairedDeviceId) },
      context
    )
  }
}

export async function subscribeSessionTabsInventory(
  context: RpcContext,
  emit: (result: unknown) => void
): Promise<void> {
  const { runtime, connectionId, requestId, pairedDeviceId } = context
  if (context.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
  const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
  const inventoryController = new AbortController()
  const abortInventory = (): void => inventoryController.abort()
  context.signal?.addEventListener('abort', abortInventory, { once: true })
  let initialized = false
  let closed = false
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
    if (!initialized) {
      // Why: the final authoritative scan subsumes these; replaying a prior epoch afterward resurrects stale host state.
      return
    }
    emit({
      type: 'updated',
      ...projectSessionTabsForClient(snapshot, context.clientKind, context.clientCapabilities)
    })
  }, pairedDeviceId)
  runtime.registerSubscriptionCleanup(
    subscriptionId,
    () => {
      closed = true
      inventoryController.abort()
      unsubscribe()
      if (initialized) {
        emit({ type: 'end' })
      }
    },
    connectionId
  )
  if (closed) {
    context.signal?.removeEventListener('abort', abortInventory)
    return
  }
  const inventory = await listSessionTabsInventory({
    ...context,
    signal: inventoryController.signal
  })
    .catch((error) => {
      runtime.cleanupSubscription(subscriptionId)
      throw error
    })
    .finally(() => context.signal?.removeEventListener('abort', abortInventory))
  if (closed) {
    return
  }
  emit({ type: 'snapshots', ...inventory })
  initialized = true
}
