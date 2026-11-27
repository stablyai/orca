import { useCallback, useEffect, useRef } from 'react'
import {
  hostSnapshotAffirmsAgentSessions,
  hostSnapshotAffirmsWorktreeContents
} from '../../../../src/shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { SESSION_TABS_PLACEHOLDER_SETTLES_RUNTIME_CAPABILITY } from '../../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'

export type AppliedSnapshotMarker = { epoch: string | null; version: number }

// Reject only older versions in the same epoch; equal versions must reprocess tombstone expiry, and a new publisher resets the floor.
export function acceptSessionSnapshot(
  incoming: { publicationEpoch?: string; snapshotVersion: number },
  marker: AppliedSnapshotMarker,
  hostSettlesPlaceholders: boolean
): boolean {
  // An "ask later" frame holds no tabs and proves none closed; keep loading and the last strip while the host owes an answer.
  if (hostSettlesPlaceholders && !hostSnapshotAffirmsWorktreeContents(incoming)) {
    return false
  }
  const incomingEpoch = incoming.publicationEpoch ?? null
  if (incomingEpoch === marker.epoch) {
    if (incoming.snapshotVersion < marker.version) {
      return false
    }
  } else {
    marker.epoch = incomingEpoch
  }
  marker.version = incoming.snapshotVersion
  return true
}

// Capabilities can arrive after connect; read them at apply time so the stable gate never rebuilds the tab stream.
export function useSessionSnapshotGate(): (
  incoming: { publicationEpoch?: string; snapshotVersion: number },
  marker: AppliedSnapshotMarker
) => boolean {
  const settles = useRouteCapability(SESSION_TABS_PLACEHOLDER_SETTLES_RUNTIME_CAPABILITY)
  const settlesRef = useRef(settles)
  useEffect(() => {
    settlesRef.current = settles
  }, [settles])
  return useCallback(
    (incoming, marker) => acceptSessionSnapshot(incoming, marker, settlesRef.current),
    []
  )
}

export function confirmsMirroredTabSelection(publicationEpoch?: string): boolean {
  // Why: phone-local persistence acknowledges the mutation, not host focus;
  // keep the pending guard until any host publication confirms the selection.
  return !publicationEpoch?.startsWith('mobile-local:')
}

/** A host that can't read its chat store lists no chats, which proves none closed: keep the chats already
 *  shown in place, inactive so the host's selection still decides which tab is open. */
export function keepChatsHostCannotRead<T extends { id: string; type: string; isActive: boolean }>(
  incoming: {
    tabs: T[]
    publicationEpoch?: string
    snapshotVersion: number
    agentSessionsUnverifiable?: true
  },
  current: readonly T[]
): T[] {
  if (
    hostSnapshotAffirmsAgentSessions(incoming) ||
    !hostSnapshotAffirmsWorktreeContents(incoming)
  ) {
    return incoming.tabs
  }
  const listedAt = new Map(incoming.tabs.map((tab, index) => [tab.id, index]))
  const tabs: T[] = []
  let next = 0
  for (const tab of current) {
    const at = listedAt.get(tab.id)
    if (at !== undefined) {
      if (at >= next) {
        tabs.push(...incoming.tabs.slice(next, at + 1))
        next = at + 1
      }
    } else if (tab.type === 'agent-session') {
      tabs.push(tab.isActive ? { ...tab, isActive: false } : tab)
    }
  }
  tabs.push(...incoming.tabs.slice(next))
  return tabs
}

// Hide locally closed tabs until host absence confirms them; expire tombstones so failed closes cannot hide live tabs forever.
export function applyClosedTabTombstones<T extends { id: string }>(
  tabs: T[],
  tombstones: Map<string, number>,
  now: number
): T[] {
  if (tombstones.size === 0) {
    return tabs
  }
  const suppressed = new Set<string>()
  const next = tabs.filter((tab) => {
    const expiry = tombstones.get(tab.id)
    if (expiry === undefined) {
      return true
    }
    if (now >= expiry) {
      tombstones.delete(tab.id)
      return true
    }
    suppressed.add(tab.id)
    return false
  })
  for (const [id, expiry] of tombstones) {
    if (!suppressed.has(id) || now >= expiry) {
      tombstones.delete(id)
    }
  }
  return next
}
