import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fileSystem from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import * as secureFile from '../../shared/secure-file'
import { ManagedDataAccountService } from './service'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fileSystem>())
}))

let root: string
let source: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-data-accounts-test-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only-key"\n')
  service = new ManagedDataAccountService(join(root, 'managed'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function openCodeSource(sessionTable = 'session'): void {
  mkdirSync(join(source, 'opencode'), { recursive: true })
  const db = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
  db.exec(
    `CREATE TABLE ${sessionTable} (id TEXT); CREATE TABLE credential (integration_id TEXT, value TEXT)`
  )
  db.prepare('INSERT INTO credential VALUES (?, ?)').run(
    'opencode-go',
    JSON.stringify({ type: 'key', key: 'test-only-key' })
  )
  db.close()
}

describe('managed data accounts', () => {
  it('resolves a pinned OpenCode profile by ID after selection changes', async () => {
    openCodeSource()
    const first = (await service.add('opencode', source, 'First')).activeAccountId
    if (!first) {
      throw new Error('Expected selected first profile')
    }
    const original = service.environmentForAccount('opencode', first)
    const second = (await service.add('opencode', source, 'Second')).activeAccountId
    if (!second) {
      throw new Error('Expected selected second profile')
    }
    expect(service.launchEnvironment('opencode')).toEqual(
      service.environmentForAccount('opencode', second)
    )
    expect(service.environmentForAccount('opencode', first)).toEqual(original)
    await service.remove('opencode', first)
    expect(() => service.environmentForAccount('opencode', first)).toThrow(
      'Managed account not found.'
    )
  })

  it.each(['before write', 'after write', 'unrestricted'])(
    'preserves credentials and original metadata when removal persistence fails %s',
    async (failure) => {
      const before = await service.add('devin', source, 'Work')
      const environment = service.launchEnvironment('devin')
      const credentialsPath = join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml')
      const credentials = readFileSync(credentialsPath)
      const metadataPath = join(root, 'managed', 'devin', 'accounts.json')
      const metadata = readFileSync(metadataPath)
      const changed = vi.fn()
      service.onChanged(changed)
      const write = secureFile.writeSecureFile
      const failingWrite = vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
        if (args[0] !== metadataPath) {
          return write(...args)
        }
        if (failure === 'before write') {
          throw new Error('metadata write failed')
        }
        write(...args)
        if (failure === 'unrestricted') {
          return false
        }
        throw new Error('metadata write failed')
      })

      await expect(service.remove('devin', before.accounts[0].id)).rejects.toThrow(
        failure === 'unrestricted' ? 'metadata permissions' : 'metadata write failed'
      )
      expect(readFileSync(credentialsPath)).toEqual(credentials)
      expect(readFileSync(metadataPath)).toEqual(metadata)
      expect(service.list('devin')).toEqual(before)
      expect(service.launchEnvironment('devin')).toEqual(environment)
      expect(changed).not.toHaveBeenCalled()
      expect(readdirSync(join(root, 'managed', 'devin')).sort()).toEqual(
        [before.accounts[0].id, 'accounts.json'].sort()
      )

      failingWrite.mockRestore()
      await service.remove('devin', before.accounts[0].id)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    }
  )

  it('retains selected account metadata when the atomic rename is locked and permits retry', async () => {
    let locked = true
    const before = await service.add('devin', source, 'Work')
    const environment = service.launchEnvironment('devin')
    const directory = join(root, 'managed', 'devin', before.accounts[0].id)
    const rename = fileSystem.renameSync
    vi.spyOn(fileSystem, 'renameSync').mockImplementation((from, to) => {
      if (locked && from === directory) {
        throw new Error('file locked')
      }
      return rename(from, to)
    })
    const metadataPath = join(root, 'managed', 'devin', 'accounts.json')
    const metadata = readFileSync(metadataPath)
    const changed = vi.fn()
    service.onChanged(changed)
    await expect(service.remove('devin', before.accounts[0].id)).rejects.toThrow('file locked')
    expect(service.list('devin')).toEqual(before)
    expect(readFileSync(metadataPath)).toEqual(metadata)
    expect(service.launchEnvironment('devin')).toEqual(environment)
    expect(
      readFileSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'), 'utf8')
    ).toContain('test-only-key')
    expect(changed).not.toHaveBeenCalled()
    locked = false
    await service.remove('devin', before.accounts[0].id)
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('preserves both transaction errors and a private recovery backup when metadata rollback fails', async () => {
    const before = await service.add('devin', source, 'Work')
    const id = before.accounts[0].id
    const directory = join(root, 'managed', 'devin', id)
    const credentialsPath = join(directory, 'data', 'devin', 'credentials.toml')
    const credentials = readFileSync(credentialsPath)
    const metadataPath = join(root, 'managed', 'devin', 'accounts.json')
    const metadata = readFileSync(metadataPath)
    const originalError = Object.assign(new Error('injected quarantine rename failure'), {
      code: 'EPERM'
    })
    const rollbackError = Object.assign(new Error('injected metadata rollback failure'), {
      code: 'EACCES'
    })
    const rename = fileSystem.renameSync
    const failingRename = vi.spyOn(fileSystem, 'renameSync').mockImplementation((from, to) => {
      if (from === directory) {
        throw originalError
      }
      if (typeof from === 'string' && from.endsWith('.rollback')) {
        throw rollbackError
      }
      return rename(from, to)
    })
    const changed = vi.fn()
    service.onChanged(changed)
    let failure: unknown
    try {
      await service.remove('devin', id)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected both removal and rollback failures.')
    }
    expect(failure.errors).toEqual([originalError, rollbackError])
    expect(failure.cause).toBe(originalError)
    expect(readFileSync(`${metadataPath}.${id}.rollback`)).toEqual(metadata)
    expect(readFileSync(credentialsPath)).toEqual(credentials)
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(service.launchEnvironment('devin')).toEqual({})
    expect(changed).not.toHaveBeenCalled()

    failingRename.mockRestore()
    await expect(service.remove('devin', id)).resolves.toEqual({
      accounts: [],
      activeAccountId: null
    })
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(`${metadataPath}.${id}.rollback`)).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('commits logical removal without reselecting a partially deleted profile and retries cleanup', async () => {
    let locked = true
    let cleanupDirectory: string | undefined
    service = new ManagedDataAccountService(join(root, 'managed'), (directory) => {
      cleanupDirectory = directory
      if (locked) {
        rmSync(join(directory, 'data'), { recursive: true, force: true })
        throw Object.assign(new Error('state file locked after credential deletion'), {
          code: 'EPERM'
        })
      }
      rmSync(directory, { recursive: true, force: true })
    })
    const before = await service.add('devin', source, 'Work')
    const id = before.accounts[0].id
    const environment = service.launchEnvironment('devin')
    mkdirSync(environment.XDG_STATE_HOME, { recursive: true })
    writeFileSync(join(environment.XDG_STATE_HOME, 'locked-file'), 'remaining private state')
    const changed = vi.fn()
    service.onChanged(changed)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(service.remove('devin', id)).resolves.toEqual({
      accounts: [],
      activeAccountId: null
    })
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(service.launchEnvironment('devin')).toEqual({})
    expect(service.transcriptEnvironments('devin')).toEqual([])
    expect(cleanupDirectory).toBeDefined()
    expect(cleanupDirectory).not.toBe(join(root, 'managed', 'devin', id))
    expect(existsSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'))).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)

    locked = false
    await expect(service.remove('devin', id)).resolves.toEqual({
      accounts: [],
      activeAccountId: null
    })
    expect(cleanupDirectory && existsSync(cleanupDirectory)).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(source, 'devin', 'credentials.toml'), 'utf8')).toContain(
      'test-only-key'
    )
  })

  it('retries quarantined cleanup on restart without reviving a removed account', async () => {
    service = new ManagedDataAccountService(join(root, 'managed'), () => {
      throw new Error('injected cleanup lock')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await service.add('devin', source, 'Work')
    const id = before.accounts[0].id
    await service.remove('devin', id)
    const pendingDirectory = join(root, 'managed', 'devin', '.pending-delete', id)
    expect(existsSync(pendingDirectory)).toBe(true)

    const restarted = new ManagedDataAccountService(join(root, 'managed'))
    expect(restarted.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(restarted.launchEnvironment('devin')).toEqual({})
    await vi.waitFor(() => expect(existsSync(pendingDirectory)).toBe(false))
    expect(restarted.list('devin')).toEqual({ accounts: [], activeAccountId: null })
  })

  it('retries every eligible quarantine while preserving registered and unrecognized directories', async () => {
    const before = await service.add('devin', source, 'Work')
    const pendingRoot = join(root, 'managed', 'devin', '.pending-delete')
    const pendingIds = Array.from({ length: 65 }, () => randomUUID())
    for (const id of [...pendingIds, before.accounts[0].id, 'unrecognized']) {
      mkdirSync(join(pendingRoot, id), { recursive: true })
    }
    const restarted = new ManagedDataAccountService(join(root, 'managed'))
    await vi.waitFor(() =>
      expect(readdirSync(pendingRoot).sort()).toEqual(
        [before.accounts[0].id, 'unrecognized'].sort()
      )
    )
    expect(restarted.list('devin')).toEqual(before)
    expect(restarted.launchEnvironment('devin')).toEqual(service.launchEnvironment('devin'))
  })

  it('registers private Devin credentials, exposes summaries, and removes only its profile', async () => {
    const state = await service.add('devin', source, 'Work')
    const id = state.accounts[0].id
    expect(JSON.stringify(state)).not.toContain('test-only-key')
    const environment = service.launchEnvironment('devin')
    expect(
      readFileSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'), 'utf8')
    ).toContain('test-only-key')
    if (process.platform !== 'win32') {
      expect(
        statSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml')).mode & 0o777
      ).toBe(0o600)
    }
    await service.select('devin', null)
    expect(service.launchEnvironment('devin')).toEqual({})
    await service.select('devin', id)
    await service.remove('devin', id)
    expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
    expect(existsSync(join(environment.XDG_DATA_HOME, 'devin', 'credentials.toml'))).toBe(false)
    expect(existsSync(join(source, 'devin', 'credentials.toml'))).toBe(true)
  })

  it('captures OpenCode 2 SQLite credentials including WAL without leaking secrets', async () => {
    openCodeSource('session_v2')
    const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    writer.pragma('journal_mode = WAL')
    writer
      .prepare('INSERT INTO credential VALUES (?, ?)')
      .run('google', JSON.stringify({ type: 'key', key: 'second-test-key' }))
    try {
      const state = await service.add('opencode', source, 'Work')
      expect(state.accounts[0].integrations).toEqual(['opencode-go', 'google'])
      const env = service.launchEnvironment('opencode')
      const captured = new SyncDatabase(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'), {
        readonly: true
      })
      expect(captured.prepare('SELECT COUNT(*) AS count FROM credential').get()?.count).toBe(2)
      captured.close()
      if (process.platform !== 'win32') {
        expect(statSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')).mode & 0o777).toBe(
          0o600
        )
      }
    } finally {
      writer.close()
    }
  })

  it.each(['session_v2', 'session_message'])(
    'rejects %s rows committed after source validation before the real SQLite backup',
    async (table) => {
      openCodeSource('session_v2')
      const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
      writer.pragma('journal_mode = WAL')
      writer.exec('CREATE TABLE session_message (data TEXT)')
      const backup = SyncDatabase.prototype.backup
      const backupSpy = vi.spyOn(SyncDatabase.prototype, 'backup').mockImplementation(function (
        this: SyncDatabase,
        destination,
        options
      ) {
        writer.prepare(`INSERT INTO ${table} VALUES (?)`).run('injected conversation after audit')
        return backup.call(this, destination, options)
      })
      try {
        await expect(service.add('opencode', source, 'Work')).rejects.toThrow(
          'conversation databases'
        )
        expect(backupSpy).toHaveBeenCalledTimes(1)
        expect(service.list('opencode')).toEqual({ accounts: [], activeAccountId: null })
        expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
        expect(writer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(1)
      } finally {
        writer.close()
      }
    }
  )

  it('rejects conversation committed by a second WAL writer during asynchronous backup', async () => {
    openCodeSource('session_v2')
    const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    writer.pragma('journal_mode = WAL')
    writer.exec('CREATE TABLE padding (data BLOB); INSERT INTO padding VALUES (zeroblob(65536))')
    let mutated = false
    const backup = SyncDatabase.prototype.backup
    vi.spyOn(SyncDatabase.prototype, 'backup').mockImplementation(function (
      this: SyncDatabase,
      destination,
      options
    ) {
      return backup.call(this, destination, {
        ...options,
        rate: 1,
        progress: ({ remainingPages }) => {
          if (!mutated && remainingPages > 0) {
            writer.prepare('INSERT INTO session_v2 VALUES (?)').run('injected concurrent session')
            mutated = true
          }
        }
      })
    })
    try {
      await expect(service.add('opencode', source, 'Work')).rejects.toThrow(
        'conversation databases'
      )
      expect(mutated).toBe(true)
      expect(service.list('opencode')).toEqual({ accounts: [], activeAccountId: null })
      expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
    } finally {
      writer.close()
    }
  })

  it('publishes integrations from the completed credential snapshot', async () => {
    openCodeSource('session_v2')
    const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    writer.pragma('journal_mode = WAL')
    const backup = SyncDatabase.prototype.backup
    vi.spyOn(SyncDatabase.prototype, 'backup').mockImplementation(function (
      this: SyncDatabase,
      destination,
      options
    ) {
      writer
        .prepare('INSERT INTO credential VALUES (?, ?)')
        .run('google', JSON.stringify({ type: 'key', key: 'injected-new-test-credential' }))
      return backup.call(this, destination, options)
    })
    try {
      const state = await service.add('opencode', source, 'Work')
      expect(state.accounts[0].integrations).toEqual(['opencode-go', 'google'])
    } finally {
      writer.close()
    }
  })

  it.each(['empty', 'invalid'])(
    'rejects %s credentials committed after source validation and preserves the selected account',
    async (change) => {
      openCodeSource('session_v2')
      const before = await service.add('opencode', source, 'Existing')
      const writer = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
      writer.pragma('journal_mode = WAL')
      const backup = SyncDatabase.prototype.backup
      vi.spyOn(SyncDatabase.prototype, 'backup').mockImplementation(function (
        this: SyncDatabase,
        destination,
        options
      ) {
        writer.exec('DELETE FROM credential')
        if (change === 'invalid') {
          writer
            .prepare('INSERT INTO credential VALUES (?, ?)')
            .run('google', '{"type":"key","key":""}')
        }
        return backup.call(this, destination, options)
      })
      try {
        await expect(service.add('opencode', source, 'Rejected')).rejects.toThrow(
          change === 'empty' ? 'supported credential' : 'credential format'
        )
        expect(service.list('opencode')).toEqual(before)
        expect(readdirSync(join(root, 'managed', 'opencode')).sort()).toEqual(
          [before.accounts[0].id, 'accounts.json'].sort()
        )
      } finally {
        writer.close()
      }
    }
  )

  it('rejects importing personal conversation databases and rolls back the directory', async () => {
    openCodeSource()
    const db = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
    db.prepare('INSERT INTO session VALUES (?)').run('personal-session')
    db.close()
    await expect(service.add('opencode', source, 'Work')).rejects.toThrow('conversation databases')
    expect(service.list('opencode').accounts).toEqual([])
    expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
  })

  it.each([
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
  ])('rejects synthetic orphan %s rows even with empty session containers', async (table) => {
    openCodeSource('session_v2')
    const databasePath = join(source, 'opencode', 'opencode.db')
    const db = new SyncDatabase(databasePath)
    // Synthetic orphans exercise damaged/FK-off files, not normal CLI writes.
    db.exec(`CREATE TABLE ${table} (data TEXT)`)
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run('private-conversation-content')
    db.close()
    const original = readFileSync(databasePath)

    await expect(service.add('opencode', source, 'Work')).rejects.toThrow('conversation databases')
    expect(service.list('opencode')).toEqual({ accounts: [], activeAccountId: null })
    expect(readdirSync(join(root, 'managed', 'opencode'))).toEqual([])
    expect(readFileSync(databasePath)).toEqual(original)
  })

  it('serializes overlapping enrollment so neither account is lost', async () => {
    await Promise.all([service.add('devin', source, 'One'), service.add('devin', source, 'Two')])
    expect(service.list('devin').accounts.map((account) => account.label)).toEqual(['One', 'Two'])
  })

  it('keeps registered transcript roots available when selection changes', async () => {
    const first = await service.add('devin', source, 'One')
    const firstEnvironment = service.launchEnvironment('devin')
    await service.add('devin', source, 'Two')
    const secondEnvironment = service.launchEnvironment('devin')
    expect(service.transcriptEnvironments('devin')).toEqual([secondEnvironment, firstEnvironment])
    await service.select('devin', first.accounts[0].id)
    expect(service.transcriptEnvironments('devin')).toEqual([firstEnvironment, secondEnvironment])
    await service.select('devin', null)
    expect(service.transcriptEnvironments('devin')).toEqual([firstEnvironment, secondEnvironment])
    await service.remove('devin', first.accounts[0].id)
    expect(service.transcriptEnvironments('devin')).toEqual([secondEnvironment])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a credential symlink without touching its target',
    async () => {
      const original = join(source, 'devin', 'credentials.toml')
      const target = join(root, 'private.toml')
      writeFileSync(target, readFileSync(original))
      rmSync(original)
      symlinkSync(target, original)
      await expect(service.add('devin', source, 'Work')).rejects.toThrow('regular file')
      expect(readFileSync(target, 'utf8')).toContain('test-only-key')
    }
  )

  it('keeps credential parse errors out of RPC messages', async () => {
    writeFileSync(
      join(source, 'devin', 'credentials.toml'),
      'windsurf_api_key = "secret-not-for-errors'
    )
    await expect(service.add('devin', source, 'Work')).rejects.toThrow(
      'Unsupported Devin credential format.'
    )
  })
})
