import { BrowserWindow, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import type { MemorySnapshot } from '../../shared/diagnostics/process-stats-types'
import type { Store } from '../persistence/loading-store/store'
import { collectMemorySnapshot } from '../memory/collector'
import { countHiddenBrowserPages, readPerfNoticeSignals } from '../perf-notices/perf-notice-signals'

import {
  assertResourceViewVisible,
  isResourceWindowVisible
} from '../window/visibility/resource-view-admission'
import type { ResourceViewAdmission } from '../../shared/diagnostics/resource-view-admission'

export function registerMemoryHandlers(store: Store, ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'memory:getSnapshot',
    (event, admission?: ResourceViewAdmission): Promise<MemorySnapshot> => {
      assertResourceViewVisible(event, admission)
      return collectMemorySnapshot(store)
    }
  )
  ipc.handle('memory:readPerfNoticeSignals', () => readPerfNoticeSignals(store))
  ipc.handle('memory:countHiddenBrowserPages', (_event, hiddenForMs: unknown) =>
    countHiddenBrowserPages(typeof hiddenForMs === 'number' ? hiddenForMs : 0)
  )
  ipc.handle('memory:resourceWindowVisible', (event) =>
    isResourceWindowVisible(BrowserWindow.fromWebContents(event.sender))
  )
}
