import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import { desktopRelayLegacyAdoption } from '../persistence/desktop-relay-legacy-adoption'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
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
      complete: z.boolean()
    })
  )
})

type RelayStore = Pick<
  Store,
  'getRepos' | 'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'patchWorkspaceSession'
>

/** One host's relay ids after the desktop window's write, or null when nothing changes. */
export function desktopRelayPatchFor(
  store: RelayStore,
  hostId: ExecutionHostId,
  write: DesktopRelayHostWrite,
  stored: WorkspaceSessionState = store.getWorkspaceSession(hostId)
): WorkspaceSessionPatch | null {
  return applyDesktopRelayWrite(stored, write, desktopRelayLegacyAdoption(store, hostId))
}

/** The desktop window's relay ids go through main, which changes only the keys the window owns. */
export function registerDesktopRelayHandlers(
  store: RelayStore,
  isFenced: (hostId: string) => boolean,
  // Main-owned layout recomputes relays from live terminals whenever a window save carries them.
  patchWindowRelays: (patch: WorkspaceSessionPatch, hostId: string) => void
): void {
  // Answering proves this main registered the apply handler; older mains reject the probe.
  ipcMain.handle('session:desktop-relays-version', () => DESKTOP_RELAY_WRITE_VERSION)

  // Skip unchanged hosts without walking their maps: same stored partition, same window ids.
  const lastApplied = new Map<string, { stored: WorkspaceSessionState; write: string }>()

  ipcMain.handle(
    'session:apply-desktop-relays',
    (_event, args: unknown): DesktopRelayWriteResult => {
      const { hosts } = desktopRelayWriteSchema.parse(args)
      const result: DesktopRelayWriteResult = { applied: [], unchanged: [], skipped: [] }
      for (const host of hosts) {
        const hostId = parseExecutionHostId(host.hostId)?.id
        if (!hostId) {
          throw new Error(`invalid_relay_host:${host.hostId}`)
        }
        if (isFenced(hostId)) {
          result.skipped.push(hostId)
          continue
        }
        const write = JSON.stringify([host.complete, host.relayIdsByTabId])
        const stored = store.getWorkspaceSession(hostId)
        const last = lastApplied.get(hostId)
        if (last?.stored === stored && last.write === write) {
          result.unchanged.push(hostId)
          continue
        }
        if (ORCA_LAYOUT_OWNER_IS_MAIN && parseExecutionHostId(hostId)?.kind !== 'runtime') {
          patchWindowRelays({ remoteSessionIdsByTabId: host.relayIdsByTabId }, hostId)
          result.applied.push(hostId)
          continue
        }
        const patch = desktopRelayPatchFor(store, hostId, host, stored)
        if (patch) {
          store.patchWorkspaceSession(patch, hostId)
          result.applied.push(hostId)
        } else {
          result.unchanged.push(hostId)
        }
        lastApplied.set(hostId, { stored: store.getWorkspaceSession(hostId), write })
      }
      return result
    }
  )
}
