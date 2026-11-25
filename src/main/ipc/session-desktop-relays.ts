import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import {
  captureLegacyRelayBaseline,
  legacyRelayAdoptionBatch,
  type LegacyRelayBaseline
} from '../persistence/desktop-relay-legacy-adoption'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import {
  applyDesktopRelayWrite,
  type DesktopRelayHostWrite
} from '../../shared/workspace-session/desktop-relay-ownership'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import {
  DESKTOP_RELAY_WRITE_VERSION,
  type DesktopRelayWriteResult
} from '../../shared/workspace-session/desktop-relay-write'

const desktopRelayHostSchema = z.object({
  hostId: z.string(),
  relayIdsByTabId: z.record(z.string(), z.string()),
  complete: z.boolean(),
  removedTabIds: z.array(z.string()).optional()
})

const desktopRelayWriteSchema = z.object({
  version: z.literal(DESKTOP_RELAY_WRITE_VERSION),
  hosts: z.array(desktopRelayHostSchema)
})

type RelayStore = Pick<
  Store,
  | 'getRepos'
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'hasWorkspaceSessionHost'
  | 'patchWorkspaceSessionRelays'
>

export type DesktopRelayHostApplied = {
  /** The relay fields to store, or null when nothing changes or the partition would hold nothing. */
  patch: Pick<
    WorkspaceSessionPatch,
    'remoteSessionIdsByTabId' | 'desktopRelayOwnerByTabId' | 'desktopRelayAdoptionVersion'
  > | null
  changedTabIds: string[]
  refused: boolean
  /** Call once `patch` is stored: a partition whose adoption it records leaves the baseline. */
  stored: () => void
}

/** One partition's relay write from the window, applied by ownership against `base` (the stored
 *  partition, or the stored partition with the same save's entries applied). */
export type DesktopRelayHostApply = (
  hostId: ExecutionHostId,
  host: DesktopRelayHostWrite,
  base: WorkspaceSessionState
) => DesktopRelayHostApplied

/** A relay write that rides with a partition's entries patch: null when absent or for another host. */
export function parseCarriedDesktopRelays(
  relays: unknown,
  hostId: string | null | undefined
): DesktopRelayHostWrite | null {
  if (relays === undefined) {
    return null
  }
  const { hostId: relayHostId, ...host } = desktopRelayHostSchema.parse(relays)
  const target = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(relayHostId)?.id !== target) {
    throw new Error(`relay_host_mismatch:${relayHostId}`)
  }
  return host
}

/** How main took relay ids a partition save carried; absent when it carried none. */
export function carriedRelayStatus(
  applied: Pick<DesktopRelayHostApplied, 'patch' | 'refused'> | null
): 'applied' | 'unchanged' | 'refused' | undefined {
  return !applied
    ? undefined
    : applied.refused
      ? 'refused'
      : applied.patch
        ? 'applied'
        : 'unchanged'
}

/** The desktop window's relay ids go through main, which changes only the keys the window owns.
 *  Returns the per-call applier the entries patch uses for relay ids that ride with it. */
export function registerDesktopRelayHandlers(
  store: RelayStore,
  isFenced: (hostId: string) => boolean
): (hostIds: readonly ExecutionHostId[]) => DesktopRelayHostApply {
  // Main-owned layout never applies the window's relay ids by ownership, so nothing is adopted there.
  const legacyBaseline: LegacyRelayBaseline = ORCA_LAYOUT_OWNER_IS_MAIN
    ? new Map()
    : captureLegacyRelayBaseline(store)
  // One apply batch: legacy adoption indexes rows at most once.
  const relayApplier = (hostIds: readonly ExecutionHostId[]): DesktopRelayHostApply => {
    const adoptionFor = legacyRelayAdoptionBatch(store, legacyBaseline, hostIds)
    return (hostId, host, base) => {
      const { patch, refused, changedTabIds } = applyDesktopRelayWrite(
        base,
        host,
        adoptionFor(hostId)
      )
      // Never materialize a partition just to record that it holds nothing.
      const kept =
        patch && (patch.remoteSessionIdsByTabId || store.hasWorkspaceSessionHost(hostId))
          ? patch
          : null
      const stored = () => {
        if (kept?.desktopRelayAdoptionVersion !== undefined) {
          legacyBaseline.delete(hostId)
        }
      }
      return { patch: kept, changedTabIds, refused, stored }
    }
  }
  // Answering proves this main registered the apply handler; older mains reject the probe.
  ipcMain.handle('session:desktop-relays-version', () => DESKTOP_RELAY_WRITE_VERSION)

  ipcMain.handle(
    'session:apply-desktop-relays',
    (_event, args: unknown): DesktopRelayWriteResult => {
      const { hosts } = desktopRelayWriteSchema.parse(args)
      const result: DesktopRelayWriteResult = {
        applied: [],
        unchanged: [],
        skipped: [],
        refused: []
      }
      const hostIds = hosts.map(({ hostId: rawHostId }) => {
        const hostId = parseExecutionHostId(rawHostId)?.id
        if (!hostId) {
          throw new Error(`invalid_relay_host:${rawHostId}`)
        }
        return hostId
      })
      const apply = relayApplier(hostIds)
      for (const [index, { hostId: _rawHostId, ...host }] of hosts.entries()) {
        const hostId = hostIds[index]!
        if (isFenced(hostId)) {
          result.skipped.push(hostId)
          continue
        }
        const { patch, refused, changedTabIds, stored } = apply(
          hostId,
          host,
          store.getWorkspaceSession(hostId)
        )
        if (refused) {
          result.refused.push(hostId)
        }
        if (patch) {
          store.patchWorkspaceSessionRelays(patch, hostId, changedTabIds)
          stored()
          result.applied.push(hostId)
        } else {
          result.unchanged.push(hostId)
        }
      }
      return result
    }
  )
  return relayApplier
}
