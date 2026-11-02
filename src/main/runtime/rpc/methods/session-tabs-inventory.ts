import {
  collectSessionTabsInventory,
  type SessionTabsInventory
} from './session-tabs-inventory-collection'
import { isDeepStrictEqual } from 'node:util'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'
import { projectSessionTabFileHosts } from './session-tab-file-host-projection'
import { createSessionTabsRetirementProofDelta } from './session-tabs-retirement-proof-delta'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { createSessionTabsTabDeltaEncoder } from '../../../../shared/session-tabs-tab-delta'

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
    projectSessionTabFileHosts(
      projectSessionTabAgentStatus(snapshot, clientKind, clientCapabilities),
      clientKind
    ),
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
  return projectInventory((await collectSessionTabsInventory(context)).inventory, context)
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
  // For the stream's whole life, not just the census: a desktop unsubscribe arrives as this abort.
  const onTransportAbort = (): void => runtime.cleanupSubscription(subscriptionId)
  context.signal?.addEventListener('abort', onTransportAbort, { once: true })
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
  const withProofDelta = createSessionTabsRetirementProofDelta(context.clientCapabilities)
  const tabDelta = createSessionTabsTabDeltaEncoder(context.clientCapabilities)
  const canonicalSnapshotsByWorktree = new Map<string, SessionTabsChange>()
  const projectChange = (snapshot: SessionTabsChange): SessionTabsChange =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection rewrites only tabs and groups; the change fields it was handed pass through.
    projectSessionTabsForClient(
      snapshot,
      context.clientKind,
      context.capabilitySource?.current ?? context.clientCapabilities
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
    const { navigationIntent: _intent, ...canonical } = snapshot
    if (snapshot.removed) {
      canonicalSnapshotsByWorktree.delete(snapshot.worktree)
    } else {
      canonicalSnapshotsByWorktree.set(snapshot.worktree, canonical)
    }
    const projected = projectChange(snapshot)
    const state = withoutNavigationIntent(projected)
    const published = publishedSnapshotsByWorktree.get(snapshot.worktree)
    if (projected.navigationIntent === undefined && isDeepStrictEqual(published, state)) {
      deliveredChangeSequenceByWorktree.set(snapshot.worktree, changeSequence)
      return
    }
    emit({
      type: 'updated',
      ...tabDelta.update(withProofDelta(projected))
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
  const stopCapabilities = context.capabilitySource?.observe(() => {
    if (!initialized || closed) {
      return
    }
    for (const snapshot of canonicalSnapshotsByWorktree.values()) {
      const projected = projectChange(snapshot)
      if (isDeepStrictEqual(publishedSnapshotsByWorktree.get(snapshot.worktree), projected)) {
        continue
      }
      emit({ type: 'updated', ...tabDelta.update(withProofDelta(projected)) })
      publishedSnapshotsByWorktree.set(snapshot.worktree, projected)
    }
  })
  runtime.registerSubscriptionCleanup(
    subscriptionId,
    () => {
      closed = true
      context.signal?.removeEventListener('abort', onTransportAbort)
      inventoryController.abort()
      unsubscribe()
      stopCapabilities?.()
      canonicalSnapshotsByWorktree.clear()
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
    return
  }
  let collected: Awaited<ReturnType<typeof collectSessionTabsInventory>> | undefined
  try {
    // Register before restore so unsubscribe/socket close can find the stream during its awaits.
    const restoring = prepareStructuredTabsIfSupported(context)
    if (restoring) {
      await restoring
      if (closed) {
        return
      }
    }
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
  }
  if (closed) {
    return
  }
  const { inventory, changeSequence } = collected
  censusChangeSequence = changeSequence
  emit({
    type: 'snapshots',
    ...(inventory.authoritative && clientUnderstandsAuthoritativeInventory(context)
      ? { authoritative: true as const }
      : {}),
    snapshots: inventory.snapshots.map((snapshot) =>
      tabDelta.full(withProofDelta(projectChange(snapshot)))
    )
  })
  for (const snapshot of inventory.snapshots) {
    const canonical = withoutNavigationIntent(snapshot)
    canonicalSnapshotsByWorktree.set(snapshot.worktree, canonical)
    publishedSnapshotsByWorktree.set(snapshot.worktree, projectChange(canonical))
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
