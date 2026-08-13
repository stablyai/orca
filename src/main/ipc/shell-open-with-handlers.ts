import { ipcMain } from 'electron'
import { extname } from 'node:path'
import {
  OPEN_WITH_CHOOSER_APPLICATION_ID,
  type ShellListOpenWithApplicationsResult,
  type ShellOpenLocalPathResult,
  type ShellOpenPathWithApplicationRequest
} from '../../shared/shell-open-types'
import type { Store } from '../persistence'
import {
  launchOpenWithApplication,
  listOpenWithApplications
} from '../open-with/open-with-applications'
import { hasActiveRuntime, validateLocalPathTarget } from './local-path-target-guard'

/** Registers the Open With listing and launch IPC handlers. */
export function registerShellOpenWithHandlers(store: Store): void {
  ipcMain.handle(
    'shell:listOpenWithApplications',
    async (_event, filePath: string): Promise<ShellListOpenWithApplicationsResult> => {
      if (hasActiveRuntime(store)) {
        return { ok: false, reason: 'remote-runtime-unsupported' }
      }
      const target = await validateLocalPathTarget(filePath)
      if (!target.ok) {
        return target
      }
      const listing = await listOpenWithApplications(target.path, {
        recentApplicationIds: store.getOpenWithRecentApplicationIds(extname(target.path))
      })
      return { ok: true, ...listing }
    }
  )

  ipcMain.handle(
    'shell:openPathWithApplication',
    async (
      _event,
      request: ShellOpenPathWithApplicationRequest
    ): Promise<ShellOpenLocalPathResult> => {
      if (hasActiveRuntime(store)) {
        return { ok: false, reason: 'remote-runtime-unsupported' }
      }
      const target = await validateLocalPathTarget(request.path)
      if (!target.ok) {
        return target
      }
      const launched = await launchOpenWithApplication(request.applicationId, target.path)
      if (!launched) {
        return { ok: false, reason: 'launch-failed' }
      }
      // Why: the Windows chooser dialog is not an application choice; Windows
      // keeps its own MRU for it.
      if (request.applicationId !== OPEN_WITH_CHOOSER_APPLICATION_ID) {
        store.recordOpenWithApplicationLaunch(extname(target.path), request.applicationId)
      }
      return { ok: true }
    }
  )
}
