import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { parse } from 'smol-toml'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { writeSecureFile } from '../../shared/secure-file'
import type { ManagedDataAccountProvider } from '../../shared/managed-account-types'

const credential = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), key: z.string().min(1) }),
  z.object({ type: z.literal('api'), key: z.string().min(1) }),
  z.object({
    type: z.literal('oauth'),
    access: z.string().min(1),
    refresh: z.string(),
    expires: z.number().nonnegative()
  }),
  z.object({ type: z.literal('wellknown'), key: z.string().min(1), token: z.string().min(1) })
])

function requireRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error('Credential capture requires a regular file smaller than 16 MiB.')
  }
}

function auditOpenCodeCredentials(database: SyncDatabase): string[] {
  database.pragma('query_only = ON')
  const sessionTables = ['session', 'session_v2'].filter((name) => tableExists(database, name))
  if (sessionTables.length === 0) {
    throw new Error('Unsupported OpenCode credential database.')
  }
  // Deleted sessions can leave orphan content or durable events behind.
  const conversationTables = [
    ...sessionTables,
    'message',
    'part',
    'todo',
    'session_message',
    'session_pending',
    'session_inbox',
    'session_input',
    'session_context_epoch',
    'instruction_blob',
    'instruction_entry',
    'instruction_state',
    'event'
  ]
  for (const table of conversationTables) {
    if (!tableExists(database, table)) {
      continue
    }
    if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error(
        'Use an isolated OpenCode login directory; importing conversation databases is not supported.'
      )
    }
  }
  const rows = database.prepare('SELECT integration_id, value FROM credential LIMIT 65').all()
  if (rows.length === 0 || rows.length > 64) {
    throw new Error('OpenCode login did not save a supported credential.')
  }
  return rows.map((row) => {
    if (typeof row.integration_id !== 'string' || typeof row.value !== 'string') {
      throw new Error('Unsupported OpenCode credential database.')
    }
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      throw new Error('Unsupported OpenCode credential format.')
    }
    if (!credential.safeParse(value).success) {
      throw new Error('Unsupported OpenCode credential format.')
    }
    return row.integration_id
  })
}

export async function captureDataAccountCredentials(
  provider: ManagedDataAccountProvider,
  sourceDataHome: string,
  destinationDataHome: string
): Promise<string[]> {
  if (provider === 'devin') {
    const source = join(sourceDataHome, 'devin', 'credentials.toml')
    requireRegularFile(source)
    const content = readFileSync(source, 'utf8')
    let parsed: unknown
    try {
      parsed = parse(content)
    } catch {
      throw new Error('Unsupported Devin credential format.')
    }
    if (!z.object({ windsurf_api_key: z.string().trim().min(1) }).safeParse(parsed).success) {
      throw new Error('Devin login did not save supported credentials.')
    }
    if (!writeSecureFile(join(destinationDataHome, 'devin', 'credentials.toml'), content)) {
      throw new Error('Could not restrict Devin credential file permissions.')
    }
    return ['devin']
  }

  const databasePath = join(sourceDataHome, 'opencode', 'opencode.db')
  requireRegularFile(databasePath)
  const database = new SyncDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1500
  })
  const destination = join(destinationDataHome, 'opencode', 'opencode.db')
  let snapshotCreated = false
  try {
    auditOpenCodeCredentials(database)
    snapshotCreated = true
    if (!writeSecureFile(destination, '')) {
      throw new Error('Could not restrict OpenCode credential file permissions.')
    }
    await database.backup(destination)
    // The source can change while SQLite copies; only the completed private snapshot is publishable.
    requireRegularFile(destination)
    const snapshot = new SyncDatabase(destination, { readonly: true, fileMustExist: true })
    try {
      return auditOpenCodeCredentials(snapshot)
    } finally {
      snapshot.close()
    }
  } catch (error) {
    if (snapshotCreated) {
      for (const path of [destination, `${destination}-wal`, `${destination}-shm`]) {
        rmSync(path, { force: true })
      }
    }
    throw error
  } finally {
    database.close()
  }
}
