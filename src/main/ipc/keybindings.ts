import { BrowserWindow, ipcMain, shell } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { authorizeExternalPath } from './filesystem-auth'

const HYDRATION_RETRY_BASE_DELAY_MS = 100
const HYDRATION_RETRY_MAX_DELAY_MS = 30_000

type HydrationRetryState = {
  attempt: number
  running: boolean
  timer: ReturnType<typeof setTimeout> | null
  onChanged: (() => void) | undefined
}

const hydrationRetryByService = new WeakMap<KeybindingService, HydrationRetryState>()

function broadcastKeybindingsChanged(snapshot: KeybindingFileSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('keybindings:changed', snapshot)
    }
  }
  rebuildAppMenu()
}

function scheduleKeybindingHydrationRetry(
  service: KeybindingService,
  state: HydrationRetryState
): void {
  const delay = Math.min(
    HYDRATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(state.attempt, 8),
    HYDRATION_RETRY_MAX_DELAY_MS
  )
  state.attempt += 1
  state.timer = setTimeout(() => {
    state.timer = null
    hydrateKeybindingsUntilReady(service, state.onChanged)
  }, delay)
  state.timer.unref?.()
}

function hydrateKeybindingsUntilReady(
  service: KeybindingService,
  onChanged: (() => void) | undefined
): void {
  const existing = hydrationRetryByService.get(service)
  const state = existing ?? { attempt: 0, running: false, timer: null, onChanged }
  state.onChanged = onChanged
  hydrationRetryByService.set(service, state)
  if (state.running || state.timer) {
    return
  }
  state.running = true
  void service
    .hydrate()
    .then((snapshot) => {
      state.running = false
      if (!service.needsHydrationRetry()) {
        hydrationRetryByService.delete(service)
        broadcastKeybindingsChanged(snapshot)
        state.onChanged?.()
        return
      }
      scheduleKeybindingHydrationRetry(service, state)
    })
    .catch((error) => {
      state.running = false
      console.warn('[keybindings] Snapshot hydration failed:', error)
      scheduleKeybindingHydrationRetry(service, state)
    })
}

export function registerKeybindingHandlers(
  service: KeybindingService,
  onChanged?: () => void
): void {
  ipcMain.handle('keybindings:get', () => service.getSnapshot())

  ipcMain.handle('keybindings:ensureFile', async () => {
    const snapshot = await service.ensureFile()
    // Why: keybindings.json lives in Orca's app config directory, not inside a
    // workspace. Opening it in the editor still needs normal fs IPC access.
    await authorizeExternalPath(snapshot.path)
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  ipcMain.handle(
    'keybindings:setAction',
    (_event, args: { actionId: KeybindingActionId; bindings: string[] | null }) => {
      const snapshot = service.setActionBindings(args.actionId, args.bindings)
      broadcastKeybindingsChanged(snapshot)
      onChanged?.()
      return snapshot
    }
  )

  ipcMain.handle('keybindings:reload', async () => {
    const snapshot = await service.reload()
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  ipcMain.handle('keybindings:openFile', async () => {
    const snapshot = await service.ensureFile()
    await authorizeExternalPath(snapshot.path)
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })

  ipcMain.handle('keybindings:revealFile', async () => {
    const snapshot = await service.ensureFile()
    await authorizeExternalPath(snapshot.path)
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })

  const hydrationService = service as Partial<KeybindingService>
  if (
    typeof hydrationService.hydrate === 'function' &&
    typeof hydrationService.needsHydrationRetry === 'function'
  ) {
    hydrateKeybindingsUntilReady(service, onChanged)
  }
}
