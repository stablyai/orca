import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

type Handler = (event: unknown, args: Record<string, unknown>) => Promise<unknown>

const handlers = new Map<string, Handler>()
const resolveAuthorizedPath = vi.fn<(path: string) => Promise<string>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: (path: string) => resolveAuthorizedPath(path)
}))

const { MAX_SQLITE_PAGE_ROWS, SQLITE_REMOTE_UNSUPPORTED_MESSAGE, registerSqliteDatabaseHandlers } =
  await import('./sqlite-database')

const FIXTURE = fileURLToPath(new URL('../sqlite/__fixtures__/sample-database.db', import.meta.url))

const store = {} as never

function invoke(channel: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return handler({}, args)
}

beforeEach(() => {
  handlers.clear()
  resolveAuthorizedPath.mockReset()
  resolveAuthorizedPath.mockImplementation(async (path) => path)
  registerSqliteDatabaseHandlers(store)
})

describe('sqlite IPC handlers', () => {
  it('routes every path through the authorization check', async () => {
    await invoke('sqlite:openDatabase', { filePath: FIXTURE })
    expect(resolveAuthorizedPath).toHaveBeenCalledWith(FIXTURE)
  })

  it('propagates a denied path instead of reading the file', async () => {
    resolveAuthorizedPath.mockRejectedValue(new Error('Path access denied'))
    await expect(invoke('sqlite:openDatabase', { filePath: '/etc/passwd' })).rejects.toThrow(
      /Path access denied/
    )
  })

  it('refuses a remote database rather than reading a local path of the same name', async () => {
    await expect(
      invoke('sqlite:openDatabase', { filePath: FIXTURE, connectionId: 'ssh-1' })
    ).rejects.toThrow(SQLITE_REMOTE_UNSUPPORTED_MESSAGE)
    expect(resolveAuthorizedPath).not.toHaveBeenCalled()
  })

  it('returns the schema for a local database', async () => {
    const overview = (await invoke('sqlite:openDatabase', { filePath: FIXTURE })) as {
      tables: { name: string }[]
    }
    expect(overview.tables.map((table) => table.name)).toContain('people')
  })

  it('names the budget, the limit, and the ask when the row limit is out of range', async () => {
    await expect(
      invoke('sqlite:readTablePage', {
        filePath: FIXTURE,
        table: 'people',
        offset: 0,
        limit: MAX_SQLITE_PAGE_ROWS + 1
      })
    ).rejects.toThrow(
      new RegExp(`asked for ${MAX_SQLITE_PAGE_ROWS + 1}.*1\\.\\.${MAX_SQLITE_PAGE_ROWS}`)
    )
  })

  it('rejects a non-integer or negative offset', async () => {
    const base = { filePath: FIXTURE, table: 'people', limit: 10 }
    await expect(invoke('sqlite:readTablePage', { ...base, offset: -1 })).rejects.toThrow(
      /Invalid row offset/
    )
    await expect(invoke('sqlite:readTablePage', { ...base, offset: 1.5 })).rejects.toThrow(
      /Invalid row offset/
    )
  })

  it('reads a page of rows', async () => {
    const page = (await invoke('sqlite:readTablePage', {
      filePath: FIXTURE,
      table: 'people',
      offset: 0,
      limit: 2
    })) as { rows: unknown[] }
    expect(page.rows).toHaveLength(2)
  })

  it('counts rows for one table', async () => {
    await expect(
      invoke('sqlite:countTableRows', { filePath: FIXTURE, table: 'people' })
    ).resolves.toBe(305)
  })
})
