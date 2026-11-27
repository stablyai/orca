import type { KeybindingService } from '../keybindings/keybinding-service'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const KEYBINDINGS_IPC_CHANNELS = [
  'keybindings:get',
  'keybindings:ensureFile',
  'keybindings:setAction',
  'keybindings:reload',
  'keybindings:openFile',
  'keybindings:revealFile'
] as const

export function registerLazyKeybindingHandlers(
  service: KeybindingService,
  onChanged?: () => void
): void {
  registerLazyIpcHandleGroup(KEYBINDINGS_IPC_CHANNELS, async (ipc) => {
    const { registerKeybindingHandlers } = await import('./keybindings')
    registerKeybindingHandlers(service, onChanged, ipc)
  })
}
