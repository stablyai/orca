import { BrowserWindow, ipcMain } from 'electron'
import { petPresenceAuthority, type PetPresenceSnapshot } from '../pet/pet-presence-authority'
import { resolveTravellingPetId } from '../pet/pet-identity'
import type { PetEdge, PetPoint, PetSurfaceKind } from '../../shared/pet-presence'

/**
 * Renderer-side access to the pet presence authority (P2).
 *
 * The RPC methods in runtime/rpc/methods/pet-presence.ts serve REMOTE clients
 * (phones). Desktop renderers and popouts reach the same singleton over IPC, so
 * every surface — local or remote — is arbitrated by one writer. The authority
 * itself is untouched by which door a client came through.
 */

const CHANGED_CHANNEL = 'petPresence:changed'

let unsubscribe: (() => void) | null = null

function broadcast(snapshot: PetPresenceSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    // Why guard on destroyed webContents too: a window can be mid-teardown when
    // a handoff fires, and sending to it throws.
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(CHANGED_CHANNEL, snapshot)
    }
  }
}

export function registerPetPresenceHandlers(): void {
  // Why idempotent: hot reload and re-registration must not stack duplicate
  // subscribers, which would send every renderer N copies of each change.
  unsubscribe?.()
  unsubscribe = petPresenceAuthority.subscribe(broadcast)

  ipcMain.handle('petPresence:get', async (): Promise<PetPresenceSnapshot> =>
    petPresenceAuthority.getState()
  )

  ipcMain.handle(
    'petPresence:registerSurface',
    async (_event, surfaceId: string, kind: PetSurfaceKind): Promise<PetPresenceSnapshot> =>
      petPresenceAuthority.registerSurface(surfaceId, kind)
  )

  ipcMain.handle('petPresence:removeSurface', async (_event, surfaceId: string): Promise<void> => {
    petPresenceAuthority.removeSurface(surfaceId)
  })

  ipcMain.handle(
    'petPresence:reportExit',
    async (
      _event,
      surfaceId: string,
      edge: PetEdge,
      position: PetPoint
    ): Promise<PetPresenceSnapshot> =>
      petPresenceAuthority.reportExit(surfaceId, edge, position)
  )

  ipcMain.handle(
    'petPresence:acknowledgeEntry',
    async (_event, surfaceId: string): Promise<PetPresenceSnapshot> =>
      petPresenceAuthority.acknowledgeEntry(surfaceId)
  )

  ipcMain.handle(
    'petPresence:setPetId',
    async (_event, petId: string): Promise<PetPresenceSnapshot> =>
      // Normalized to the slug: the renderer knows this pet by a per-install
      // UUID, which means nothing to a phone.
      petPresenceAuthority.setPetId(resolveTravellingPetId(petId))
  )

  ipcMain.handle(
    'petPresence:claim',
    async (_event, surfaceId: string): Promise<PetPresenceSnapshot> =>
      petPresenceAuthority.claim(surfaceId)
  )
}
