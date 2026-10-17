import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import type { SqliteDatabaseOverview, SqliteTablePage } from '../../shared/sqlite-database'
import { SqliteDatabaseReader } from '../sqlite/sqlite-reader'

// Tripwire: far past what any viewport shows, so only a broken caller reaches it.
export const MAX_SQLITE_PAGE_ROWS = 500

export const SQLITE_REMOTE_UNSUPPORTED_MESSAGE =
  'Opening SQLite databases on SSH hosts is not supported yet. Copy the file locally to inspect it.'

// Reopened per call rather than caching handles across IPC, so a closed tab can never leak one.
async function withReader<T>(
  filePath: string,
  store: Store,
  connectionId: string | undefined,
  run: (reader: SqliteDatabaseReader) => T | Promise<T>
): Promise<T> {
  if (connectionId !== undefined) {
    throw new Error(SQLITE_REMOTE_UNSUPPORTED_MESSAGE)
  }
  const resolved = await resolveAuthorizedPath(filePath, store)
  const reader = SqliteDatabaseReader.open(resolved)
  try {
    // Awaited so a future async callback cannot outlive the close below.
    return await run(reader)
  } finally {
    reader.close()
  }
}

export function registerSqliteDatabaseHandlers(store: Store): void {
  ipcMain.handle(
    'sqlite:openDatabase',
    async (
      _event,
      args: { filePath: string; connectionId?: string }
    ): Promise<SqliteDatabaseOverview> =>
      withReader(args.filePath, store, args.connectionId, (reader) => reader.overview())
  )

  ipcMain.handle(
    'sqlite:countTableRows',
    async (
      _event,
      args: { filePath: string; table: string; connectionId?: string }
    ): Promise<number> =>
      withReader(args.filePath, store, args.connectionId, (reader) => reader.countRows(args.table))
  )

  ipcMain.handle(
    'sqlite:readTablePage',
    async (
      _event,
      args: {
        filePath: string
        table: string
        offset: number
        limit: number
        connectionId?: string
      }
    ): Promise<SqliteTablePage> => {
      if (!Number.isInteger(args.offset) || args.offset < 0) {
        throw new Error(`Invalid row offset: ${args.offset}`)
      }
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SQLITE_PAGE_ROWS) {
        throw new Error(
          `Invalid row limit: asked for ${args.limit}, allowed range is 1..${MAX_SQLITE_PAGE_ROWS}`
        )
      }
      return withReader(args.filePath, store, args.connectionId, (reader) =>
        reader.readTablePage(args.table, args.offset, args.limit)
      )
    }
  )
}
