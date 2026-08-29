import { isDeepStrictEqual } from 'node:util'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'

type SessionTabsInventory = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative?: true
}

type SessionTabsChange = RuntimeMobileSessionTabsResult & { removed?: true }

const MAX_BUFFERED_CENSUS_CHANGES = 256
const MAX_CENSUS_COLLECTION_ATTEMPTS = 3

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

async function collectSessionTabsInventory(
  context: RpcContext,
  includeChangeSequence = false
): Promise<{
  inventory: SessionTabsInventory
  changeSequence: number
}> {
  const { runtime, pairedDeviceId, signal } = context
  // Why: a failed census degrades inside the runtime to the same scan without
  // the authoritative label, so no client ever pays a second full collection.
  if (!includeChangeSequence) {
    const inventory = runtime.supportsAuthoritativeSessionTabsInventory()
      ? await runtime.listAllMobileSessionTabsInventory(pairedDeviceId, signal)
      : { snapshots: await runtime.listAllMobileSessionTabs(pairedDeviceId) }
    return { inventory: projectInventory(inventory, context), changeSequence: 0 }
  }
  const collected = runtime.supportsAuthoritativeSessionTabsInventory()
    ? await runtime.listAllMobileSessionTabsInventoryWithChangeSequence(pairedDeviceId, signal)
    : await runtime.listAllMobileSessionTabsWithChangeSequence(pairedDeviceId)
  return {
    inventory: projectInventory(collected, context),
    changeSequence: collected.changeSequence
  }
}

export async function listSessionTabsInventory(context: RpcContext): Promise<SessionTabsInventory> {
  return (await collectSessionTabsInventory(context)).inventory
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
  const bufferedChanges: { snapshot: SessionTabsChange; changeSequence: number }[] = []
  const bufferedOrdinaryChangeByWorktree = new Map<
    string,
    { index: number; membershipKey: string; changeSequence: number }
  >()
  const bufferedNavigationIntentByWorktree = new Map<
    string,
    { index: number; changeSequence: number }
  >()
  const publishedSnapshotsByWorktree = new Map<string, SessionTabsChange>()
  const deliveredChangeSequenceByWorktree = new Map<string, number>()
  let censusChangeSequence: number | undefined
  let censusInvalidated = false
  const projectChange = (snapshot: SessionTabsChange): SessionTabsChange =>
    projectSessionTabsForClient(
      snapshot,
      context.clientKind,
      context.clientCapabilities
    ) as SessionTabsChange
  const withoutNavigationIntent = (snapshot: SessionTabsChange): SessionTabsChange => {
    if (snapshot.navigationIntent === undefined) {
      return snapshot
    }
    const { navigationIntent: _navigationIntent, ...state } = snapshot
    return state as SessionTabsChange
  }
  const membershipKey = (snapshot: SessionTabsChange): string =>
    JSON.stringify({
      removed: snapshot.removed === true,
      tabs: snapshot.tabs.map((tab) => ({
        type: tab.type,
        id: tab.id
      }))
    })
  const clearBufferedChanges = (): void => {
    bufferedChanges.length = 0
    bufferedOrdinaryChangeByWorktree.clear()
    bufferedNavigationIntentByWorktree.clear()
  }
  const reserveBufferedChange = (): void => {
    if (bufferedChanges.length < MAX_BUFFERED_CENSUS_CHANGES) {
      return
    }
    clearBufferedChanges()
    censusInvalidated = true
  }
  const bufferChange = (snapshot: SessionTabsChange, changeSequence: number): void => {
    if (snapshot.navigationIntent !== undefined) {
      const previous = bufferedNavigationIntentByWorktree.get(snapshot.worktree)
      if (previous) {
        if (changeSequence > previous.changeSequence) {
          bufferedChanges[previous.index] = { snapshot, changeSequence }
          previous.changeSequence = changeSequence
        }
        return
      }
      reserveBufferedChange()
      const index = bufferedChanges.push({ snapshot, changeSequence }) - 1
      bufferedNavigationIntentByWorktree.set(snapshot.worktree, { index, changeSequence })
      return
    }
    const nextMembershipKey = membershipKey(snapshot)
    const previous = bufferedOrdinaryChangeByWorktree.get(snapshot.worktree)
    if (previous?.membershipKey === nextMembershipKey) {
      if (changeSequence > previous.changeSequence) {
        bufferedChanges[previous.index] = { snapshot, changeSequence }
        previous.changeSequence = changeSequence
      }
      return
    }
    reserveBufferedChange()
    const index = bufferedChanges.push({ snapshot, changeSequence }) - 1
    bufferedOrdinaryChangeByWorktree.set(snapshot.worktree, {
      index,
      membershipKey: nextMembershipKey,
      changeSequence
    })
  }
  const publishChange = (snapshot: SessionTabsChange, changeSequence: number): void => {
    const projected = projectChange(snapshot)
    const state = withoutNavigationIntent(projected)
    const published = publishedSnapshotsByWorktree.get(snapshot.worktree)
    if (projected.navigationIntent === undefined && isDeepStrictEqual(published, state)) {
      deliveredChangeSequenceByWorktree.set(snapshot.worktree, changeSequence)
      return
    }
    emit({
      type: 'updated',
      ...projected
    })
    if (projected.removed === true) {
      publishedSnapshotsByWorktree.delete(snapshot.worktree)
      deliveredChangeSequenceByWorktree.delete(snapshot.worktree)
    } else {
      publishedSnapshotsByWorktree.set(snapshot.worktree, state)
      deliveredChangeSequenceByWorktree.set(snapshot.worktree, changeSequence)
    }
  }
  const unsubscribe = runtime.onMobileSessionTabsChanged((runtimeSnapshot, changeSequence) => {
    const snapshot = runtimeSnapshot as SessionTabsChange
    if (!initialized) {
      bufferChange(snapshot, changeSequence)
      return
    }
    if (
      changeSequence <= (censusChangeSequence ?? 0) ||
      changeSequence <= (deliveredChangeSequenceByWorktree.get(snapshot.worktree) ?? 0)
    ) {
      return
    }
    publishChange(snapshot, changeSequence)
  }, pairedDeviceId)
  runtime.registerSubscriptionCleanup(
    subscriptionId,
    () => {
      closed = true
      inventoryController.abort()
      unsubscribe()
      clearBufferedChanges()
      publishedSnapshotsByWorktree.clear()
      deliveredChangeSequenceByWorktree.clear()
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
  let collected: Awaited<ReturnType<typeof collectSessionTabsInventory>> | undefined
  try {
    for (let attempt = 1; !collected; attempt += 1) {
      censusInvalidated = false
      const candidate = await collectSessionTabsInventory(
        { ...context, signal: inventoryController.signal },
        true
      )
      if (closed) {
        return
      }
      if (censusInvalidated) {
        clearBufferedChanges()
        if (attempt === MAX_CENSUS_COLLECTION_ATTEMPTS) {
          throw new Error('session_tabs_inventory_unstable')
        }
      } else {
        collected = candidate
      }
    }
  } catch (error) {
    runtime.cleanupSubscription(subscriptionId)
    throw error
  } finally {
    context.signal?.removeEventListener('abort', abortInventory)
  }
  if (closed) {
    return
  }
  const { inventory, changeSequence } = collected
  censusChangeSequence = changeSequence
  emit({ type: 'snapshots', ...inventory })
  for (const snapshot of inventory.snapshots) {
    publishedSnapshotsByWorktree.set(snapshot.worktree, withoutNavigationIntent(snapshot))
  }
  bufferedChanges.sort((left, right) => left.changeSequence - right.changeSequence)
  for (const buffered of bufferedChanges) {
    if (closed) {
      break
    }
    if (buffered.changeSequence > changeSequence) {
      publishChange(buffered.snapshot, buffered.changeSequence)
    }
  }
  clearBufferedChanges()
  if (closed) {
    return
  }
  initialized = true
}
