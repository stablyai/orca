import { ipcMain } from 'electron'
import { isValidNpmPackageName } from '../../shared/npm-package-name'
import {
  NPM_PACKAGE_INFO_LOOKUP_CHANNEL,
  type NpmPackageInfoRequest,
  type NpmPackageInfoResult
} from '../../shared/npm-package-info-types'
import { createNpmPackageInfoService } from '../npm-package-info/npm-package-info-service'
import type { Store } from '../persistence'

const MALFORMED_REQUEST_RESULT: NpmPackageInfoResult = { status: 'unavailable', reason: 'error' }

function isWellFormedRequest(value: unknown): value is NpmPackageInfoRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    typeof request.packageName === 'string' &&
    typeof request.worktreeRoot === 'string' &&
    typeof request.executionHostId === 'string' &&
    isValidNpmPackageName(request.packageName)
  )
}

/**
 * Registers the single method this domain exposes. Per AGENTS.md rule: never
 * throws across `ipcMain.handle` (Electron would surface only an opaque
 * "Error invoking channel" to the renderer) — every path returns the
 * discriminated `NpmPackageInfoResult` instead.
 */
export function registerNpmPackageInfoHandlers(store: Store): void {
  const service = createNpmPackageInfoService(store)

  ipcMain.handle(
    NPM_PACKAGE_INFO_LOOKUP_CHANNEL,
    async (_event, request: unknown): Promise<NpmPackageInfoResult> => {
      if (!isWellFormedRequest(request)) {
        return MALFORMED_REQUEST_RESULT
      }
      try {
        return await service.lookup(request)
      } catch {
        return MALFORMED_REQUEST_RESULT
      }
    }
  )
}
