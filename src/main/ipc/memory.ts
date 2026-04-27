import { ipcMain } from 'electron'
import type { MemorySnapshot } from '../../shared/types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'

export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle('memory:getSnapshot', (): Promise<MemorySnapshot> => collectMemorySnapshot(store))
}
