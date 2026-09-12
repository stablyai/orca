import type { SqliteDatabaseOverview, SqliteTablePage } from '../../shared/sqlite-database'

export type SqliteApi = {
  openDatabase: (args: { filePath: string; connectionId?: string }) => Promise<SqliteDatabaseOverview>
  countTableRows: (args: {
    filePath: string
    table: string
    connectionId?: string
  }) => Promise<number>
  readTablePage: (args: {
    filePath: string
    table: string
    offset: number
    limit: number
    connectionId?: string
  }) => Promise<SqliteTablePage>
}
