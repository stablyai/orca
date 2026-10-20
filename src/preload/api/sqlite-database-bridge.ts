import { ipcRenderer } from 'electron'
import type { SqliteDatabaseOverview, SqliteTablePage } from '../../shared/sqlite-database'
import type { PreloadApi } from '../api-types'

export const sqliteApi = {
  openDatabase: (args: {
    filePath: string
    connectionId?: string
  }): Promise<SqliteDatabaseOverview> => ipcRenderer.invoke('sqlite:openDatabase', args),
  countTableRows: (args: {
    filePath: string
    table: string
    connectionId?: string
  }): Promise<number> => ipcRenderer.invoke('sqlite:countTableRows', args),
  readTablePage: (args: {
    filePath: string
    table: string
    offset: number
    limit: number
    connectionId?: string
  }): Promise<SqliteTablePage> => ipcRenderer.invoke('sqlite:readTablePage', args)
} satisfies PreloadApi['sqlite']
