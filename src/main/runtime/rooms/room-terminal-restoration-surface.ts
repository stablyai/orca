import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { RoomHarnessRuntime } from './harness-adapter-types'

export function resolveRoomTerminalRestorationSurface(
  runtime: RoomHarnessRuntime,
  worktreeId: string,
  paneKey: string
): { placement?: { tabId: string; leafId: string }; persisted: boolean } {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return { persisted: false }
  }
  return {
    placement: { tabId: pane.tabId, leafId: pane.leafId },
    persisted: runtime.hasPersistedTerminalSurface?.(worktreeId, paneKey) === true
  }
}
