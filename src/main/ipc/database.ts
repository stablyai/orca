import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { decryptDbSecret, getDbEncryptionStatus } from '../database/db-credential-store'
import { dbConnectionManager } from '../database/db-connection-manager'
import { normalizeDbError, resolveDbConfig, type ResolvedDbConfig } from '../database/db-driver'
import { isTrustedUIRenderer } from './ui'
import type {
  DbColumnListResult,
  DbConnection,
  DbConnectionInput,
  DbConnectionRuntimeState,
  DbConnectionSummary,
  DbConnectionUpdate,
  DbEncryptionStatus,
  DbEngine,
  DbIntrospectResult,
  DbTableListResult,
  DbTableRef,
  DbTestResult
} from '../../shared/database-types'

// Phase 2 surface: connection CRUD + encryption posture. Phase 3 adds the live
// lifecycle (test/connect/disconnect/statuses); introspect/query come later.
const DATABASE_IPC_CHANNELS = [
  'database:list',
  'database:add',
  'database:update',
  'database:remove',
  'database:encryptionStatus',
  'database:test',
  'database:connect',
  'database:disconnect',
  'database:statuses',
  'database:introspect',
  'database:introspectSchemaTables',
  'database:introspectTableColumns'
] as const

const VALID_ENGINES = new Set<DbEngine>(['postgres', 'mysql'])

// Why: never hand the stored secret back to the renderer — it only needs to know
// whether a password exists.
function toSummary(connection: DbConnection): DbConnectionSummary {
  const { password: _password, ...rest } = connection
  return { ...rest, hasPassword: !!connection.password }
}

// Why: the sender is already gated to the trusted UI renderer, but coerce the
// core fields so a malformed payload can't poison persisted state.
function sanitizeInput(input: DbConnectionInput): DbConnectionInput {
  if (!VALID_ENGINES.has(input.engine)) {
    throw new Error('invalid_engine')
  }
  const port = Number(input.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('invalid_port')
  }
  return {
    name: String(input.name ?? '').trim(),
    engine: input.engine,
    host: String(input.host ?? '').trim(),
    port,
    database: String(input.database ?? '').trim(),
    user: String(input.user ?? '').trim(),
    password: input.password ? String(input.password) : undefined,
    ssl: input.ssl,
    readOnly: input.readOnly ?? false,
    sshTunnel: input.sshTunnel
  }
}

// Why: decrypt is strict/fail-closed — a keychain-changed secret throws here
// rather than handing a bogus credential to a driver. Resolves the saved record
// into a dial-ready config (password decrypted at point-of-use; SSL smart-by-host).
function resolveSavedConfig(store: Store, id: string): ResolvedDbConfig {
  const connection = store.getDbConnection(id)
  if (!connection) {
    throw new Error('db_connection_not_found')
  }
  const password = connection.password ? decryptDbSecret(connection.password) : undefined
  return resolveDbConfig(connection, password)
}

// Build a config for a one-shot Test from the form: a typed password wins; an
// empty field on an existing connection falls back to its stored secret.
function resolveTestConfig(
  store: Store,
  input: DbConnectionInput,
  id: string | undefined
): ResolvedDbConfig {
  const existing = id ? store.getDbConnection(id) : undefined
  let password = input.password
  if (!password && existing?.password) {
    password = decryptDbSecret(existing.password)
  }
  return resolveDbConfig(
    {
      id: id ?? 'db-test',
      name: input.name,
      engine: input.engine,
      host: input.host,
      port: input.port,
      database: input.database,
      user: input.user,
      ssl: input.ssl,
      readOnly: input.readOnly ?? false,
      createdAt: 0,
      updatedAt: 0
    },
    password
  )
}

export function registerDatabaseHandlers(store: Store): void {
  // Why: on macOS re-activation this can be called again; ipcMain.handle throws
  // on a duplicate channel, so clear any prior handlers first (mirrors SSH).
  for (const channel of DATABASE_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  // Why (mirrors ui.ts onUIChanged): the DB view is desktop-main-window only, so
  // broadcast every runtime status change to all live windows — the renderer
  // re-hydrates from these instead of polling.
  dbConnectionManager.setStatusListener((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('database:status-changed', state)
      }
    }
  })

  // Why (red-team F15): the renderer is sandboxed but the channel is reachable;
  // reject any sender that is not the trusted main-window UI renderer.
  const requireTrusted = (sender: WebContents): void => {
    if (!isTrustedUIRenderer(sender)) {
      throw new Error('untrusted_sender')
    }
  }

  ipcMain.handle('database:list', (event): DbConnectionSummary[] => {
    requireTrusted(event.sender)
    return store.getDbConnections().map(toSummary)
  })

  ipcMain.handle(
    'database:add',
    (event, args: { input: DbConnectionInput }): DbConnectionSummary => {
      requireTrusted(event.sender)
      return toSummary(store.addDbConnection(sanitizeInput(args.input)))
    }
  )

  ipcMain.handle(
    'database:update',
    (event, args: { id: string; updates: DbConnectionUpdate }): DbConnectionSummary | null => {
      requireTrusted(event.sender)
      const updated = store.updateDbConnection(args.id, args.updates)
      return updated ? toSummary(updated) : null
    }
  )

  ipcMain.handle('database:remove', (event, args: { id: string }): void => {
    requireTrusted(event.sender)
    store.removeDbConnection(args.id)
  })

  ipcMain.handle('database:encryptionStatus', (event): DbEncryptionStatus => {
    requireTrusted(event.sender)
    return getDbEncryptionStatus()
  })

  // Why: Test returns its result (never throws a raw rejection) so a failure
  // carries only the redacted { code, safeMessage } — the raw driver error
  // embeds the DSN/password.
  ipcMain.handle(
    'database:test',
    async (event, args: { input: DbConnectionInput; id?: string }): Promise<DbTestResult> => {
      requireTrusted(event.sender)
      try {
        await dbConnectionManager.test(resolveTestConfig(store, args.input, args.id))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: normalizeDbError(err) }
      }
    }
  )

  ipcMain.handle(
    'database:connect',
    async (event, args: { id: string }): Promise<DbConnectionRuntimeState> => {
      requireTrusted(event.sender)
      try {
        return await dbConnectionManager.connect(resolveSavedConfig(store, args.id))
      } catch (err) {
        // Why: the manager already pushed an `error` status via broadcast; return
        // the redacted state so the caller never sees the raw rejection.
        return { id: args.id, status: 'error', error: normalizeDbError(err) }
      }
    }
  )

  ipcMain.handle('database:disconnect', async (event, args: { id: string }): Promise<void> => {
    requireTrusted(event.sender)
    await dbConnectionManager.disconnect(args.id)
  })

  ipcMain.handle('database:statuses', (event): DbConnectionRuntimeState[] => {
    requireTrusted(event.sender)
    return dbConnectionManager.getAllStatuses()
  })

  // Why: introspection results are returned (never thrown) so a bad catalog read
  // surfaces a redacted error inline instead of crashing the schema tree.
  ipcMain.handle(
    'database:introspect',
    async (event, args: { id: string }): Promise<DbIntrospectResult> => {
      requireTrusted(event.sender)
      try {
        return { ok: true, tree: await dbConnectionManager.introspectSchemas(args.id) }
      } catch (err) {
        return { ok: false, error: normalizeDbError(err) }
      }
    }
  )

  ipcMain.handle(
    'database:introspectSchemaTables',
    async (event, args: { id: string; schema: string }): Promise<DbTableListResult> => {
      requireTrusted(event.sender)
      try {
        return { ok: true, list: await dbConnectionManager.introspectTables(args.id, args.schema) }
      } catch (err) {
        return { ok: false, error: normalizeDbError(err) }
      }
    }
  )

  ipcMain.handle(
    'database:introspectTableColumns',
    async (event, args: { id: string; ref: DbTableRef }): Promise<DbColumnListResult> => {
      requireTrusted(event.sender)
      try {
        return { ok: true, columns: await dbConnectionManager.introspectColumns(args.id, args.ref) }
      } catch (err) {
        return { ok: false, error: normalizeDbError(err) }
      }
    }
  )
}
