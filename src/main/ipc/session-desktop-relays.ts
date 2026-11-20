import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import {
  captureLegacyRelayBaseline,
  legacyRelayAdoptionBatch
} from '../persistence/desktop-relay-legacy-adoption'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { applyDesktopRelayWrite } from '../../shared/workspace-session/desktop-relay-ownership'
import {
  DESKTOP_RELAY_WRITE_VERSION,
  type DesktopRelayWriteResult
} from '../../shared/workspace-session/desktop-relay-write'

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

/** The desktop window's relay ids go through main, which changes only the keys the window owns. */
export function registerDesktopRelayHandlers(
  store: RelayStore,
  isFenced: (hostId: string) => boolean
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
        const { patch, refused, changedTabIds } = applyDesktopRelayWrite(
          store.getWorkspaceSession(hostId),
          host,
          adoptionFor(hostId)
        )
        if (refused) {
          result.refused.push(hostId)
        }
        existing ??= new Set(store.getWorkspaceSessionHostIds())
        // Never materialize a partition just to record that it holds nothing.
        if (patch && (existing.has(hostId) || patch.remoteSessionIdsByTabId)) {
          store.patchWorkspaceSessionRelays(patch, hostId, changedTabIds)
          result.applied.push(hostId)
        } else {
          result.unchanged.push(hostId)
        }
      }
      return result
    }
  )
}
