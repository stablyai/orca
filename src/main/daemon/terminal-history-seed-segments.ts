import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import {
  DISARM_MOUSE_TRACKING_SEQUENCE,
  restoreHasMouseTrackingArmed
} from './terminal-mode-rehydrate-sequences'

export function getRecoveredHistorySeedSegments(restoreInfo: ColdRestoreInfo): readonly string[] {
  const disarmMouse = restoreHasMouseTrackingArmed(restoreInfo.modes)
  if (restoreInfo.modes.alternateScreen) {
    // Why only the normal buffer (and no escape tail): the dead TUI's alt
    // frame and any mid-escape tail it left belong to a process that is gone;
    // restoring them into the fresh shell would corrupt its first live bytes.
    const normalBuffer = restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi
    if (!normalBuffer) {
      return []
    }
    // Why the disarm: SerializeAddon can bake the dead session's mouse-tracking
    // DECSET into the restored content, so the new shell would echo raw SGR
    // motion bytes on every pointer move without it (#12101).
    return disarmMouse ? [normalBuffer, DISARM_MOUSE_TRACKING_SEQUENCE] : [normalBuffer]
  }
  const body = [restoreInfo.rehydrateSequences, restoreInfo.snapshotAnsi].filter(
    (segment) => segment.length > 0
  )
  return [
    ...body,
    // Why gated on body: an empty body seeded no enable to undo, and nothing
    // may precede a lone escape tail.
    ...(disarmMouse && body.length > 0 ? [DISARM_MOUSE_TRACKING_SEQUENCE] : []),
    // Why the tail stays last, even when body is empty: it's a dangling
    // partial escape the live subprocess's own next bytes must complete
    // (#7329); anything after it would be consumed by the dangling sequence.
    ...(restoreInfo.pendingEscapeTailAnsi ? [restoreInfo.pendingEscapeTailAnsi] : [])
  ]
}
