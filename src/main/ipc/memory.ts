import { BrowserWindow, ipcMain } from 'electron'
import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'

import {
  assertResourceViewVisible,
  isResourceWindowVisible
} from '../window/resource-view-admission'
import type { ResourceViewAdmission } from '../../shared/resource-view-admission'

export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle(
    'memory:getSnapshot',
    (event, admission?: ResourceViewAdmission): Promise<MemorySnapshot> => {
      assertResourceViewVisible(event, admission)
      return collectMemorySnapshot(store)
    }
  )
  ipcMain.handle('memory:resourceWindowVisible', (event) =>
    isResourceWindowVisible(BrowserWindow.fromWebContents(event.sender))
  )
}
