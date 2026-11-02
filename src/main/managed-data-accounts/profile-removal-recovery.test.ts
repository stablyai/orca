import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fileSystem from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedDataAccountProvider } from '../../shared/managed-account-types'
import { writeSecureFile } from '../../shared/secure-file'
import { ManagedDataAccountService } from './service'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fileSystem>())
}))

let root: string
let storage: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-account-removal-recovery-'))
  storage = join(root, 'managed')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function interruptedRemoval(
  provider: ManagedDataAccountProvider = 'devin',
  id: string = randomUUID()
) {
  const providerRoot = join(storage, provider)
  const directory = join(providerRoot, id)
  const credentialsPath = join(directory, 'data', 'test-credentials')
  const metadataPath = join(providerRoot, 'accounts.json')
  const rollbackPath = `${metadataPath}.${id}.rollback`
  const before = {
    accounts: [{ id, label: 'Private test profile', integrations: [], createdAt: 1 }],
    activeAccountId: id
  }
  mkdirSync(join(directory, 'data'), { recursive: true })
  writeFileSync(credentialsPath, 'private-test-only-credential')
  expect(writeSecureFile(rollbackPath, JSON.stringify(before), { durable: true })).toBe(true)
  expect(
    writeSecureFile(metadataPath, JSON.stringify({ accounts: [], activeAccountId: null }), {
      durable: true
    })
  ).toBe(true)
  return { id, providerRoot, directory, credentialsPath, metadataPath, rollbackPath, before }
}

async function finishStartup(service: ManagedDataAccountService) {
  await service.select('devin', null)
}

describe('interrupted managed account removal recovery', () => {
  it.each(['devin', 'opencode'] as const)(
    'quarantines the canonical %s directory registered with an uppercase UUID',
    async (provider) => {
      const fixture = interruptedRemoval(provider)
      const id = fixture.id.toUpperCase()
      const registered = {
        accounts: [{ ...fixture.before.accounts[0], id }],
        activeAccountId: id
      }
      expect(writeSecureFile(fixture.metadataPath, JSON.stringify(registered))).toBe(true)
      const cleanup = vi.fn(() => {
        throw new Error('cleanup deferred')
      })
      const service = new ManagedDataAccountService(storage, cleanup)

      await expect(service.remove(provider, id)).resolves.toEqual({
        accounts: [],
        activeAccountId: null
      })

      const pendingRoot = join(fixture.providerRoot, '.pending-delete')
      const pendingDirectory = join(pendingRoot, fixture.id)
      expect(cleanup).toHaveBeenCalledWith(pendingDirectory)
      expect(readdirSync(pendingRoot)).toEqual([fixture.id])
      expect(existsSync(fixture.directory)).toBe(false)
      expect(readFileSync(join(pendingDirectory, 'data', 'test-credentials'), 'utf8')).toBe(
        'private-test-only-credential'
      )
      expect(existsSync(fixture.rollbackPath)).toBe(false)

      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(existsSync(pendingDirectory)).toBe(false)
      expect(restarted.list(provider)).toEqual({ accounts: [], activeAccountId: null })
    }
  )

  it.each(['devin', 'opencode'] as const)(
    'quarantines a committed %s removal left before quarantine on restart',
    async (provider) => {
      const fixture = interruptedRemoval(provider)
      const restarted = new ManagedDataAccountService(storage)
      expect(restarted.list(provider)).toEqual({ accounts: [], activeAccountId: null })
      expect(restarted.launchEnvironment(provider)).toEqual({})
      await finishStartup(restarted)
      expect(existsSync(fixture.directory)).toBe(false)
      expect(existsSync(fixture.rollbackPath)).toBe(false)
      expect(restarted.list(provider)).toEqual({ accounts: [], activeAccountId: null })
    }
  )

  it.each(['lowercase', 'uppercase'] as const)(
    'recovers after quarantine and rollback fail for a %s registered UUID',
    async (spelling) => {
      const source = join(root, 'source')
      mkdirSync(join(source, 'devin'), { recursive: true })
      writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only"')
      const service = new ManagedDataAccountService(storage)
      const added = await service.add('devin', source, 'Work')
      const directoryId = added.accounts[0].id
      const id = spelling === 'uppercase' ? directoryId.toUpperCase() : directoryId
      const before = {
        accounts: [{ ...added.accounts[0], id }],
        activeAccountId: id
      }
      const directory = join(storage, 'devin', directoryId)
      const credentialsPath = join(directory, 'data', 'devin', 'credentials.toml')
      const metadataPath = join(storage, 'devin', 'accounts.json')
      const rollbackPath = `${metadataPath}.${directoryId}.rollback`
      expect(writeSecureFile(metadataPath, JSON.stringify(before))).toBe(true)
      const credentials = readFileSync(credentialsPath)
      const original = readFileSync(metadataPath)
      const rename = fileSystem.renameSync
      const failingRename = vi.spyOn(fileSystem, 'renameSync').mockImplementation((from, to) => {
        if (from === directory || from === rollbackPath) {
          throw new Error('injected removal and rollback lock')
        }
        return rename(from, to)
      })
      await expect(service.remove('devin', id)).rejects.toBeInstanceOf(AggregateError)
      expect(service.list('devin')).toEqual({ accounts: [], activeAccountId: null })
      expect(readFileSync(credentialsPath)).toEqual(credentials)
      expect(readFileSync(rollbackPath)).toEqual(original)
      failingRename.mockRestore()

      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(existsSync(directory)).toBe(false)
      expect(existsSync(rollbackPath)).toBe(false)
      expect(restarted.list('devin')).toEqual({ accounts: [], activeAccountId: null })
      expect(readFileSync(join(source, 'devin', 'credentials.toml'), 'utf8')).toContain('test-only')
    }
  )

  it('retains recovery evidence when quarantine is locked and continues other removals', async () => {
    const locked = interruptedRemoval()
    const other = interruptedRemoval()
    const rename = fileSystem.renameSync
    const failingRename = vi.spyOn(fileSystem, 'renameSync').mockImplementation((from, to) => {
      if (from === locked.directory) {
        throw new Error('quarantine locked')
      }
      return rename(from, to)
    })
    const restarted = new ManagedDataAccountService(storage)
    await finishStartup(restarted)
    expect(existsSync(locked.directory)).toBe(true)
    expect(readFileSync(locked.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    expect(existsSync(locked.rollbackPath)).toBe(true)
    expect(existsSync(other.directory)).toBe(false)
    expect(existsSync(other.rollbackPath)).toBe(false)
    failingRename.mockRestore()

    const retry = new ManagedDataAccountService(storage)
    await finishStartup(retry)
    expect(existsSync(locked.directory)).toBe(false)
    expect(existsSync(locked.rollbackPath)).toBe(false)
  })

  it('leaves failed cleanup quarantined and retries it without restoring metadata', async () => {
    const fixture = interruptedRemoval()
    const restarted = new ManagedDataAccountService(storage, () => {
      throw new Error('cleanup locked')
    })
    await finishStartup(restarted)
    const pendingDirectory = join(fixture.providerRoot, '.pending-delete', fixture.id)
    expect(existsSync(fixture.directory)).toBe(false)
    expect(readFileSync(join(pendingDirectory, 'data', 'test-credentials'), 'utf8')).toBe(
      'private-test-only-credential'
    )
    expect(restarted.list('devin')).toEqual({ accounts: [], activeAccountId: null })

    const retry = new ManagedDataAccountService(storage)
    await finishStartup(retry)
    expect(existsSync(pendingDirectory)).toBe(false)
    expect(existsSync(fixture.rollbackPath)).toBe(false)
    expect(retry.list('devin')).toEqual({ accounts: [], activeAccountId: null })
  })

  it('retains backup evidence while an original profile collides with its quarantine', async () => {
    const fixture = interruptedRemoval()
    const pendingDirectory = join(fixture.providerRoot, '.pending-delete', fixture.id)
    mkdirSync(pendingDirectory, { recursive: true })
    writeFileSync(join(pendingDirectory, 'private-state'), 'earlier-quarantine-test-data')
    const restarted = new ManagedDataAccountService(storage)
    await finishStartup(restarted)
    expect(existsSync(pendingDirectory)).toBe(false)
    expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    expect(existsSync(fixture.rollbackPath)).toBe(true)
    expect(restarted.list('devin')).toEqual({ accounts: [], activeAccountId: null })

    const retry = new ManagedDataAccountService(storage)
    await finishStartup(retry)
    expect(existsSync(fixture.directory)).toBe(false)
    expect(existsSync(fixture.rollbackPath)).toBe(false)
    expect(retry.list('devin')).toEqual({ accounts: [], activeAccountId: null })
  })

  it('preserves registered profiles, their markers and quarantines, and unmarked directories', async () => {
    const fixture = interruptedRemoval()
    expect(writeSecureFile(fixture.metadataPath, JSON.stringify(fixture.before))).toBe(true)
    const pendingDirectory = join(fixture.providerRoot, '.pending-delete', fixture.id)
    const unmarked = join(fixture.providerRoot, randomUUID())
    mkdirSync(pendingDirectory, { recursive: true })
    mkdirSync(unmarked)
    writeFileSync(join(unmarked, 'private-data'), 'unregistered-is-not-removal-evidence')
    const marker = readFileSync(fixture.rollbackPath)
    const restarted = new ManagedDataAccountService(storage)
    await restarted.select('devin', fixture.id)
    expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    expect(readFileSync(fixture.rollbackPath)).toEqual(marker)
    expect(existsSync(pendingDirectory)).toBe(true)
    expect(readFileSync(join(unmarked, 'private-data'), 'utf8')).toBe(
      'unregistered-is-not-removal-evidence'
    )
    expect(restarted.list('devin')).toEqual(fixture.before)
  })

  it.each(['lowercase', 'uppercase'] as const)(
    'preserves original credentials registered with a %s UUID spelling',
    async (spelling) => {
      const lowerId = randomUUID()
      const registeredId = spelling === 'lowercase' ? lowerId : lowerId.toUpperCase()
      const markerId = spelling === 'lowercase' ? lowerId.toUpperCase() : lowerId
      const fixture = interruptedRemoval('devin', markerId)
      const registered = {
        accounts: [{ ...fixture.before.accounts[0], id: registeredId }],
        activeAccountId: registeredId
      }
      expect(writeSecureFile(fixture.metadataPath, JSON.stringify(registered))).toBe(true)
      const marker = readFileSync(fixture.rollbackPath)
      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
      expect(readFileSync(fixture.rollbackPath)).toEqual(marker)
      await expect(restarted.remove('devin', markerId)).rejects.toThrow(
        'Managed account not found.'
      )
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
      expect(restarted.list('devin').accounts).toEqual(registered.accounts)
    }
  )

  it.each(['lowercase', 'uppercase'] as const)(
    'preserves a quarantine registered with a %s UUID spelling',
    async (spelling) => {
      const lowerId = randomUUID()
      const registeredId = spelling === 'lowercase' ? lowerId : lowerId.toUpperCase()
      const markerId = spelling === 'lowercase' ? lowerId.toUpperCase() : lowerId
      const fixture = interruptedRemoval('devin', markerId)
      const registered = {
        accounts: [{ ...fixture.before.accounts[0], id: registeredId }],
        activeAccountId: registeredId
      }
      expect(writeSecureFile(fixture.metadataPath, JSON.stringify(registered))).toBe(true)
      const pendingDirectory = join(fixture.providerRoot, '.pending-delete', markerId)
      const pendingCredentials = join(pendingDirectory, 'data', 'test-credentials')
      mkdirSync(join(fixture.providerRoot, '.pending-delete'), { recursive: true })
      fileSystem.renameSync(fixture.directory, pendingDirectory)
      const marker = readFileSync(fixture.rollbackPath)
      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(readFileSync(pendingCredentials, 'utf8')).toBe('private-test-only-credential')
      expect(readFileSync(fixture.rollbackPath)).toEqual(marker)
      await expect(restarted.remove('devin', markerId)).rejects.toThrow(
        'Managed account not found.'
      )
      expect(readFileSync(pendingCredentials, 'utf8')).toBe('private-test-only-credential')
      expect(restarted.list('devin').accounts).toEqual(registered.accounts)
    }
  )

  it('recovers an unregistered profile when its marker contains another UUID spelling', async () => {
    const fixture = interruptedRemoval('devin', randomUUID().toUpperCase())
    const before = {
      accounts: [{ ...fixture.before.accounts[0], id: fixture.id.toLowerCase() }],
      activeAccountId: fixture.id.toLowerCase()
    }
    expect(writeSecureFile(fixture.rollbackPath, JSON.stringify(before))).toBe(true)
    const restarted = new ManagedDataAccountService(storage)
    await finishStartup(restarted)
    expect(existsSync(fixture.directory)).toBe(false)
    expect(existsSync(fixture.rollbackPath)).toBe(false)
  })

  it.each(['invalid JSON', 'invalid state', 'different id', 'directory', 'missing marker'])(
    'preserves original credentials without valid removal evidence: %s',
    async (invalid) => {
      const fixture = interruptedRemoval()
      if (invalid === 'invalid JSON') {
        writeFileSync(fixture.rollbackPath, '{')
      } else if (invalid === 'invalid state') {
        writeFileSync(fixture.rollbackPath, JSON.stringify({ accounts: [{ id: fixture.id }] }))
      } else if (invalid === 'different id') {
        writeFileSync(
          fixture.rollbackPath,
          JSON.stringify({ ...fixture.before, accounts: [], activeAccountId: null })
        )
      } else {
        rmSync(fixture.rollbackPath)
        if (invalid === 'directory') {
          mkdirSync(fixture.rollbackPath)
        }
      }
      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
      await expect(restarted.remove('devin', fixture.id)).rejects.toThrow()
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    }
  )

  it('preserves unreadable backups and continues other eligible removals', async () => {
    const unreadable = interruptedRemoval()
    const other = interruptedRemoval()
    const read = fileSystem.readFileSync
    const failingRead = vi.spyOn(fileSystem, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === unreadable.rollbackPath) {
        throw Object.assign(new Error('private backup unreadable'), { code: 'EACCES' })
      }
      return read(...args)
    })
    const restarted = new ManagedDataAccountService(storage)
    await finishStartup(restarted)
    expect(readFileSync(unreadable.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    expect(existsSync(unreadable.rollbackPath)).toBe(true)
    expect(existsSync(other.directory)).toBe(false)
    failingRead.mockRestore()

    const retry = new ManagedDataAccountService(storage)
    await finishStartup(retry)
    expect(existsSync(unreadable.directory)).toBe(false)
    expect(existsSync(unreadable.rollbackPath)).toBe(false)
  })

  it('rejects a linked provider directory without deleting another provider profile', async () => {
    const fixture = interruptedRemoval('opencode')
    const alias = join(storage, 'devin')
    symlinkSync(fixture.providerRoot, alias, 'junction')
    expect(writeSecureFile(fixture.metadataPath, JSON.stringify(fixture.before))).toBe(true)
    const restarted = new ManagedDataAccountService(storage)
    await restarted.select('opencode', fixture.id)
    expect(console.warn).toHaveBeenCalledWith(
      '[managed-data-accounts] Could not retry private account directory cleanup.'
    )
    expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    expect(existsSync(fixture.rollbackPath)).toBe(true)
  })

  it('ignores non-UUID markers and cleans only valid completed removal markers', async () => {
    const fixture = interruptedRemoval()
    rmSync(fixture.directory, { recursive: true })
    const invalid = join(fixture.providerRoot, 'accounts.json.unrecognized.rollback')
    writeFileSync(invalid, JSON.stringify(fixture.before))
    const restarted = new ManagedDataAccountService(storage)
    await finishStartup(restarted)
    expect(existsSync(fixture.rollbackPath)).toBe(false)
    expect(existsSync(invalid)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a marker symlink without touching its target',
    async () => {
      const fixture = interruptedRemoval()
      const target = join(root, 'outside-backup')
      const backup = readFileSync(fixture.rollbackPath)
      writeFileSync(target, backup)
      rmSync(fixture.rollbackPath)
      symlinkSync(target, fixture.rollbackPath)
      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
      await expect(restarted.remove('devin', fixture.id)).rejects.toThrow()
      expect(readFileSync(target)).toEqual(backup)
      expect(readFileSync(fixture.credentialsPath, 'utf8')).toBe('private-test-only-credential')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a profile symlink without touching its target',
    async () => {
      const fixture = interruptedRemoval()
      const target = join(root, 'outside-profile')
      mkdirSync(target)
      writeFileSync(join(target, 'private-data'), 'outside-private-test-data')
      rmSync(fixture.directory, { recursive: true })
      symlinkSync(target, fixture.directory)
      const restarted = new ManagedDataAccountService(storage)
      await finishStartup(restarted)
      expect(readFileSync(join(target, 'private-data'), 'utf8')).toBe('outside-private-test-data')
      expect(existsSync(fixture.rollbackPath)).toBe(true)
    }
  )
})
