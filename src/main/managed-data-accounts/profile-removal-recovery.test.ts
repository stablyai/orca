import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type * as fileSystem from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedDataAccountProvider } from '../../shared/managed-account-types'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
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
