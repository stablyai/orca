import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import {
  captureLegacyRelayBaseline,
  legacyRelayAdoptionBatch
} from '../persistence/desktop-relay-legacy-adoption'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import {
  applyDesktopRelayWrite,
  type DesktopRelayHostWrite
} from '../../shared/workspace-session/desktop-relay-ownership'
import {
  DESKTOP_RELAY_WRITE_VERSION,
  type DesktopRelayWriteResult
} from '../../shared/workspace-session/desktop-relay-write'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

const desktopRelayWriteSchema = z.object({
  version: z.literal(DESKTOP_RELAY_WRITE_VERSION),
  hosts: z.array(
    z.object({
      hostId: z.string(),
      relayIdsByTabId: z.record(z.string(), z.string()),
      complete: z.boolean(),
      removedTabIds: z.array(z.string()).optional()
    })
  )
})

type RelayStore = Pick<
  Store,
  'getRepos' | 'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'patchWorkspaceSessionRelays'
>

/** The relay map a window's write describes, applied without ownership (main-owned layout). */
function windowRelayMap(
  stored: WorkspaceSessionState,
  write: DesktopRelayHostWrite
): Record<string, string> {
  if (!write.removedTabIds) {
    return write.relayIdsByTabId
  }
  const relays = { ...stored.remoteSessionIdsByTabId, ...write.relayIdsByTabId }
  for (const tabId of write.removedTabIds) {
    delete relays[tabId]
  }
  return relays
}

/** The desktop window's relay ids go through main, which changes only the keys the window owns. */
export function registerDesktopRelayHandlers(
  store: RelayStore,
  isFenced: (hostId: string) => boolean,
  // Main-owned layout recomputes relays from live terminals whenever a window save carries them.
  patchWindowRelays: (patch: WorkspaceSessionPatch, hostId: string) => void
): void {
  const legacyBaseline = captureLegacyRelayBaseline(store)
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
      const adoptionFor = legacyRelayAdoptionBatch(store, legacyBaseline)
      let existing: Set<string> | null = null
      for (const host of hosts) {
        const hostId = parseExecutionHostId(host.hostId)?.id
        if (!hostId) {
          throw new Error(`invalid_relay_host:${host.hostId}`)
        }
        if (isFenced(hostId)) {
          result.skipped.push(hostId)
          continue
        }
        existing ??= new Set(store.getWorkspaceSessionHostIds())
        if (ORCA_LAYOUT_OWNER_IS_MAIN && parseExecutionHostId(hostId)?.kind !== 'runtime') {
          const relays = windowRelayMap(store.getWorkspaceSession(hostId), host)
          if (existing.has(hostId) || Object.keys(relays).length > 0) {
            patchWindowRelays({ remoteSessionIdsByTabId: relays }, hostId)
          }
          result.applied.push(hostId)
          continue
        }
        const { patch, refused } = applyDesktopRelayWrite(
          store.getWorkspaceSession(hostId),
          host,
          adoptionFor(hostId)
        )
        if (refused) {
          result.refused.push(hostId)
        }
        // Never materialize a partition just to record that it holds nothing.
        if (patch && (existing.has(hostId) || patch.remoteSessionIdsByTabId)) {
          store.patchWorkspaceSessionRelays(patch, hostId)
          result.applied.push(hostId)
        } else {
          result.unchanged.push(hostId)
        }
      }
      return result
    }
  )
}
