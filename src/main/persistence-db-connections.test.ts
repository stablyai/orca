import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { DbConnection, DbConnectionInput } from '../shared/database-types'

// Shared mutable state so the electron mock can reference a per-test directory
const testState = { dir: '' }

const { isEncryptionAvailableMock, encryptStringMock, decryptStringMock } = vi.hoisted(() => ({
  isEncryptionAvailableMock: vi.fn(() => true),
  encryptStringMock: vi.fn((plaintext: string) =>
    Buffer.from(`mock-encrypted:${plaintext}`, 'utf-8')
  ),
  decryptStringMock: vi.fn((ciphertext: Buffer) => {
    const decoded = ciphertext.toString('utf-8')
    if (!decoded.startsWith('mock-encrypted:')) {
      throw new Error('invalid ciphertext')
    }
    return decoded.slice('mock-encrypted:'.length)
  })
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('./git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn()
}))

// Reset modules and dynamically import Store so the data-file path picks up testState.dir
async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

function readDataFile(): unknown {
  return JSON.parse(readFileSync(dataFile(), 'utf-8'))
}

const makeDbConnectionInput = (overrides: Partial<DbConnectionInput> = {}): DbConnectionInput => ({
  name: 'test-db',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  password: 'testpass',
  ...overrides
})

describe('Store DB Connections CRUD', () => {
  beforeEach(() => {
    testState.dir = join(tmpdir(), `orca-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    vi.clearAllMocks()
    isEncryptionAvailableMock.mockReturnValue(true)
    encryptStringMock.mockImplementation((plaintext: string) =>
      Buffer.from(`mock-encrypted:${plaintext}`, 'utf-8')
    )
    decryptStringMock.mockImplementation((ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('mock-encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('mock-encrypted:'.length)
    })
  })

  afterEach(() => {
    if (testState.dir) {
      rmSync(testState.dir, { recursive: true, force: true })
    }
  })

  describe('addDbConnection', () => {
    it('assigns a uuid id + createdAt/updatedAt timestamps', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()

      const connection = store.addDbConnection(input)

      expect(connection.id).toBeDefined()
      expect(connection.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(connection.createdAt).toBeGreaterThan(0)
      expect(connection.updatedAt).toEqual(connection.createdAt)
    })

    it('defaults readOnly to false', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ readOnly: undefined })

      const connection = store.addDbConnection(input)

      expect(connection.readOnly).toBe(false)
    })

    it('stores password in tagged ENC form (not plaintext)', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ password: 'mysecret' })

      const connection = store.addDbConnection(input)

      expect(connection.password).toMatch(/^db\.safeStorage\.v1:/)
      expect(connection.password).not.toContain('mysecret')
    })

    it('stores no password field if password is omitted', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ password: undefined })

      const connection = store.addDbConnection(input)

      expect(connection.password).toBeUndefined()
    })

    it('returns connection in getDbConnections', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()

      const added = store.addDbConnection(input)
      const list = store.getDbConnections()

      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(added.id)
      expect(list[0].name).toBe(input.name)
    })

    it('triggers a save on addDbConnection', async () => {
      const store = await createStore()
      const scheduleSaveSpy = vi.spyOn(store as unknown as { scheduleSave: () => void }, 'scheduleSave')
      const input = makeDbConnectionInput({ password: 'mysecret' })

      store.addDbConnection(input)

      expect(scheduleSaveSpy).toHaveBeenCalled()
    })

    it('falls back to RAW prefix when encryption unavailable', async () => {
      isEncryptionAvailableMock.mockReturnValue(false)
      const store = await createStore()
      const input = makeDbConnectionInput({ password: 'mysecret' })

      const connection = store.addDbConnection(input)

      expect(connection.password).toBe('db.plaintext.v1:mysecret')
    })
  })

  describe('updateDbConnection', () => {
    it('omitting password leaves stored secret unchanged', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ password: 'original' })
      const added = store.addDbConnection(input)
      const originalPassword = added.password

      const updated = store.updateDbConnection(added.id, { name: 'renamed' })

      expect(updated?.password).toBe(originalPassword)
    })

    it('passing new password replaces it in tagged form', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ password: 'original' })
      const added = store.addDbConnection(input)

      const updated = store.updateDbConnection(added.id, { password: 'newsecret' })

      expect(updated?.password).toMatch(/^db\.safeStorage\.v1:/)
      expect(updated?.password).not.toContain('newsecret')
      // Check that it was indeed stored
      expect(updated?.password).toBeDefined()
    })

    it('passing empty password string keeps existing secret', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput({ password: 'original' })
      const added = store.addDbConnection(input)
      const originalPassword = added.password

      const updated = store.updateDbConnection(added.id, { password: '' })

      expect(updated?.password).toBe(originalPassword)
    })

    it('updates non-password fields', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()
      const added = store.addDbConnection(input)

      const updated = store.updateDbConnection(added.id, {
        name: 'newname',
        host: 'newhost',
        port: 3306
      })

      expect(updated?.name).toBe('newname')
      expect(updated?.host).toBe('newhost')
      expect(updated?.port).toBe(3306)
    })

    it('advances updatedAt timestamp', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()
      const added = store.addDbConnection(input)
      const originalUpdatedAt = added.updatedAt

      // Small delay to ensure time difference
      await new Promise((r) => setTimeout(r, 10))

      const updated = store.updateDbConnection(added.id, { name: 'newname' })

      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt)
    })

    it('returns null if connection not found', async () => {
      const store = await createStore()

      const result = store.updateDbConnection('nonexistent-id', { name: 'test' })

      expect(result).toBeNull()
    })
  })

  describe('removeDbConnection', () => {
    it('removes connection from store', async () => {
      const store = await createStore()
      const input1 = makeDbConnectionInput({ name: 'db1' })
      const input2 = makeDbConnectionInput({ name: 'db2' })
      const added1 = store.addDbConnection(input1)
      const added2 = store.addDbConnection(input2)

      store.removeDbConnection(added1.id)

      const list = store.getDbConnections()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(added2.id)
    })

    it('triggers save when removing connection', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()
      const added = store.addDbConnection(input)
      const scheduleSaveSpy = vi.spyOn(store as unknown as { scheduleSave: () => void }, 'scheduleSave')

      store.removeDbConnection(added.id)

      expect(scheduleSaveSpy).toHaveBeenCalled()
    })

    it('silently ignores removal of nonexistent id', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()
      store.addDbConnection(input)

      expect(() => store.removeDbConnection('nonexistent-id')).not.toThrow()

      const list = store.getDbConnections()
      expect(list).toHaveLength(1)
    })
  })

  describe('normalizeDbConnection on load', () => {
    it('loads missing readOnly as false', async () => {
      const now = Date.now()
      const persistedData = {
        dbConnections: [
          {
            id: 'test-1',
            name: 'test',
            engine: 'postgres' as const,
            host: 'localhost',
            port: 5432,
            database: 'db',
            user: 'user',
            createdAt: now,
            updatedAt: now
            // readOnly intentionally omitted
          } as unknown as DbConnection
        ]
      }
      writeDataFile(persistedData)

      const store = await createStore()
      const list = store.getDbConnections()

      expect(list[0].readOnly).toBe(false)
    })

    it('loads invalid ssl as undefined', async () => {
      const now = Date.now()
      const persistedData = {
        dbConnections: [
          {
            id: 'test-1',
            name: 'test',
            engine: 'postgres' as const,
            host: 'localhost',
            port: 5432,
            database: 'db',
            user: 'user',
            ssl: 'invalid-mode',
            createdAt: now,
            updatedAt: now,
            readOnly: false
          }
        ]
      }
      writeDataFile(persistedData)

      const store = await createStore()
      const list = store.getDbConnections()

      expect(list[0].ssl).toBeUndefined()
    })

    it('loads valid ssl value unchanged', async () => {
      const now = Date.now()
      const persistedData = {
        dbConnections: [
          {
            id: 'test-1',
            name: 'test',
            engine: 'postgres' as const,
            host: 'localhost',
            port: 5432,
            database: 'db',
            user: 'user',
            ssl: 'verify-full' as const,
            createdAt: now,
            updatedAt: now,
            readOnly: false
          }
        ]
      }
      writeDataFile(persistedData)

      const store = await createStore()
      const list = store.getDbConnections()

      expect(list[0].ssl).toBe('verify-full')
    })

    it('preserves password field through round-trip', async () => {
      const now = Date.now()
      const persistedData = {
        dbConnections: [
          {
            id: 'test-1',
            name: 'test',
            engine: 'postgres' as const,
            host: 'localhost',
            port: 5432,
            database: 'db',
            user: 'user',
            password: 'db.safeStorage.v1:mock-encrypted:mysecret',
            createdAt: now,
            updatedAt: now,
            readOnly: false
          }
        ]
      }
      writeDataFile(persistedData)

      const store = await createStore()
      const list = store.getDbConnections()

      expect(list[0].password).toBe('db.safeStorage.v1:mock-encrypted:mysecret')
    })
  })

  describe('getDbConnection by id', () => {
    it('returns connection by id', async () => {
      const store = await createStore()
      const input = makeDbConnectionInput()
      const added = store.addDbConnection(input)

      const retrieved = store.getDbConnection(added.id)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(added.id)
      expect(retrieved?.name).toBe(input.name)
    })

    it('returns undefined for nonexistent id', async () => {
      const store = await createStore()

      const retrieved = store.getDbConnection('nonexistent-id')

      expect(retrieved).toBeUndefined()
    })
  })

  describe('data file persistence', () => {
    it('maintains connections in in-memory state', async () => {
      const store = await createStore()
      store.addDbConnection(makeDbConnectionInput({ password: 'mysecret' }))

      const list = store.getDbConnections()
      expect(list).toHaveLength(1)
      expect(list[0].password).toMatch(/^db\.safeStorage\.v1:/)
    })

    it('maintains connections without password in state', async () => {
      const store = await createStore()
      store.addDbConnection(makeDbConnectionInput({ password: undefined }))

      const list = store.getDbConnections()
      expect(list).toHaveLength(1)
      expect(list[0].password).toBeUndefined()
    })
  })

  describe('encryption on disk vs in memory', () => {
    it('keeps tagged password in memory after adding', async () => {
      const store = await createStore()
      const inMemory = store.addDbConnection(makeDbConnectionInput({ password: 'mysecret' }))

      // In memory, password is tagged (encrypted or plaintext prefix) — never raw.
      expect(inMemory.password).toMatch(/^db\.(safeStorage\.v1:|plaintext\.v1:)/)
    })

    it('plaintext passwords are encrypted before storage (in-memory return)', async () => {
      const store = await createStore()
      const plaintext = 'mysecret'
      const stored = store.addDbConnection(makeDbConnectionInput({ password: plaintext }))

      expect(stored.password).not.toBe(plaintext)
      expect(stored.password).toMatch(/^db\./)
    })

    // Why: the real security guarantee is what reaches orca-data.json. BOTH the
    // sync (flush/shutdown) and async (debounced) write paths must persist the
    // tagged ciphertext, never the plaintext (red-team F2 / both-write-paths).
    it('sync write path (flush) persists tagged ciphertext, not plaintext', async () => {
      const store = await createStore()
      const plaintext = 'on-disk-secret-sync'
      store.addDbConnection(makeDbConnectionInput({ password: plaintext }))

      store.flush()

      const persisted = readDataFile() as { dbConnections?: { password?: string }[] }
      expect(persisted.dbConnections).toHaveLength(1)
      expect(persisted.dbConnections?.[0]?.password).toMatch(/^db\.safeStorage\.v1:/)
      expect(persisted.dbConnections?.[0]?.password).not.toContain(plaintext)
    })

    it('async write path (debounced) persists tagged ciphertext, not plaintext', async () => {
      const store = await createStore()
      const plaintext = 'on-disk-secret-async'
      store.addDbConnection(makeDbConnectionInput({ password: plaintext }))

      // Poll until the debounced write actually lands: a fixed sleep can race a
      // slow CI timer (the 300ms debounce may fire later than any wall-clock
      // guess, and waitForPendingWrite is a no-op until the timer sets it).
      let persisted: { dbConnections?: { password?: string }[] } = {}
      for (let i = 0; i < 200; i++) {
        await store.waitForPendingWrite()
        // The file may not exist until the first debounced write lands.
        try {
          persisted = readDataFile() as { dbConnections?: { password?: string }[] }
        } catch {
          persisted = {}
        }
        if (persisted.dbConnections?.[0]?.password) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      expect(persisted.dbConnections?.[0]?.password).toMatch(/^db\.safeStorage\.v1:/)
      expect(persisted.dbConnections?.[0]?.password).not.toContain(plaintext)
    })

    it('warn-and-store (no OS backend) persists RAW-tagged value on disk', async () => {
      isEncryptionAvailableMock.mockReturnValue(false)
      const store = await createStore()
      const plaintext = 'weak-backend-secret'
      store.addDbConnection(makeDbConnectionInput({ password: plaintext }))

      store.flush()

      const persisted = readDataFile() as { dbConnections?: { password?: string }[] }
      // No keystore → warn-and-store: value is RAW-tagged (the form banner warned
      // the user it is recoverable at rest); it is NOT silently dropped.
      expect(persisted.dbConnections?.[0]?.password).toBe(`db.plaintext.v1:${plaintext}`)
    })
  })
})
