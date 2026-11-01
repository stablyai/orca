/**
 * The window's half of a UNC Windows-drive conversion (D1c): its stores (quick-open history, file
 * view preferences, notebook interpreters) live in the renderer's own storage, so it converts them
 * once it opens and records each here. The journal goes once every store is recorded.
 */
import {
  WSL_DRIVE_UNC_RENDERER_STORE_IDS,
  type WslDriveUncPendingRendererRewrite
} from '../../shared/wsl-drive-unc-renderer-store-keys'
import type { WslMoveRecordStoreRewrittenResult } from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import {
  listWslDriveUncConversions,
  removeWslDriveUncConversion,
  writeWslDriveUncConversion,
  type WslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'

const RENDERER_STORE_IDS: readonly string[] = WSL_DRIVE_UNC_RENDERER_STORE_IDS

/** The profile and every store, main and renderer, are converted. */
export function isWslDriveUncConversionComplete(
  record: Pick<WslDriveUncConversion, 'phase' | 'rewrittenStores'>,
  mainStoreIds: readonly string[] = []
): boolean {
  return (
    record.phase === 'profile-rewritten' &&
    [...mainStoreIds, ...RENDERER_STORE_IDS].every((id) => record.rewrittenStores.includes(id))
  )
}

/** Conversions whose profile is rewritten; the renderer re-applies even recorded stores. */
export function listPendingWslDriveUncRendererRewrites(
  userDataPath: string
): WslDriveUncPendingRendererRewrite[] {
  return listWslDriveUncConversions(userDataPath)
    .filter((record) => record.phase === 'profile-rewritten')
    .map((record) => ({
      migrationId: record.migrationId,
      distro: record.distro,
      worktreeIds: record.worktreeIds,
      rootPaths: record.rootPaths,
      storeIds: RENDERER_STORE_IDS.filter((id) => !record.rewrittenStores.includes(id))
    }))
}

export function recordWslDriveUncRendererStoreRewritten(
  userDataPath: string,
  request: { migrationId: string; storeId: string },
  mainStoreIds: readonly string[]
): WslMoveRecordStoreRewrittenResult {
  if (!RENDERER_STORE_IDS.includes(request.storeId)) {
    return { recorded: false, reason: 'unknown-store' }
  }
  try {
    const record = listWslDriveUncConversions(userDataPath).find(
      (entry) => entry.migrationId === request.migrationId
    )
    if (
      !record ||
      record.phase !== 'profile-rewritten' ||
      record.rewrittenStores.includes(request.storeId)
    ) {
      return { recorded: false, reason: 'not-pending' }
    }
    const next = {
      ...record,
      rewrittenStores: [...record.rewrittenStores, request.storeId],
      updatedAt: new Date().toISOString()
    }
    if (isWslDriveUncConversionComplete(next, mainStoreIds)) {
      removeWslDriveUncConversion(userDataPath, request.migrationId)
    } else {
      writeWslDriveUncConversion(userDataPath, next)
    }
    return { recorded: true }
  } catch (error) {
    console.warn('[wsl-drive-unc] Could not record a renderer store:', error)
    return { recorded: false, reason: 'failed' }
  }
}
