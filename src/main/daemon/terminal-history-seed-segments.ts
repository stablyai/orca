import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'

export function getRecoveredHistorySeedSegments(restoreInfo: ColdRestoreInfo): readonly string[] {
  if (restoreInfo.modes.alternateScreen) {
    const normalBuffer = restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi
    return normalBuffer ? [normalBuffer] : []
  }
  return [
    restoreInfo.rehydrateSequences,
    restoreInfo.snapshotAnsi,
    ...(restoreInfo.pendingEscapeTailAnsi ? [restoreInfo.pendingEscapeTailAnsi] : [])
  ].filter((segment) => segment.length > 0)
}
