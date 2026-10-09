import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

export function registerRepoPathStatusHandler(
  runtime: Pick<OrcaRuntimeService, 'listRepoPathStatuses'>
): void {
  ipcMain.handle('repos:getPathStatuses', (_event, args?: { force?: boolean }) =>
    runtime.listRepoPathStatuses({ force: args?.force === true })
  )
}
