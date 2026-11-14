import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as filesystem from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import * as secureFile from '../../shared/secure-storage/secure-file'
import { ManagedDataAccountService } from './service'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return { ...actual }
})

let root: string
let source: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-enrollment-persistence-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only-key"\n')
  mkdirSync(join(source, 'opencode'), { recursive: true })
  const database = new SyncDatabase(join(source, 'opencode', 'opencode.db'))
  database.exec(
    'CREATE TABLE session_v2 (id TEXT); CREATE TABLE credential (integration_id TEXT, value TEXT)'
  )
  database
    .prepare('INSERT INTO credential VALUES (?, ?)')
    .run('google', '{"type":"key","key":"test-only-key"}')
  database.close()
  service = new ManagedDataAccountService(join(root, 'managed'), undefined, { platform: 'linux' })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe.each(['opencode', 'devin'] as const)('committed %s enrollment', (provider) => {
  it('cleans an unregistered profile when metadata fails before publication', async () => {
    const metadata = join(root, 'managed', provider, 'accounts.json')
    const write = secureFile.writeSecureFile
    vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
      if (args[0] === metadata) {
        throw new Error('pre-publication write failure')
      }
      return write(...args)
    })
    await expect(service.add(provider, source, 'Work')).rejects.toThrow('pre-publication')
    expect(service.list(provider)).toEqual({ accounts: [], activeAccountId: null })
    expect(readdirSync(join(root, 'managed', provider))).toEqual([])
  })

  it('preserves a profile registered with another UUID case', async () => {
    const metadata = join(root, 'managed', provider, 'accounts.json')
    const write = secureFile.writeSecureFile
    const writer = vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
      const result = write(...args)
      if (args[0] !== metadata) {
        return result
      }
      const state = service.list(provider)
      writeFileSync(
        metadata,
        JSON.stringify({
          ...state,
          accounts: state.accounts.map((account) => ({ ...account, id: account.id.toUpperCase() })),
          activeAccountId: state.activeAccountId?.toUpperCase()
        })
      )
      throw new Error('post-publication UUID case change')
    })
    await expect(service.add(provider, source, 'Work')).rejects.toThrow('UUID case change')
    writer.mockRestore()
    const registered = service.list(provider).accounts[0]
    const dataHome = join(root, 'managed', provider, registered.id.toLowerCase(), 'data')
    expect(existsSync(dataHome)).toBe(true)
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBe(dataHome)
    expect(
      service.transcriptEnvironments(provider).map((environment) => environment.XDG_DATA_HOME)
    ).toEqual([dataHome])
    expect((await service.select(provider, registered.id.toLowerCase())).activeAccountId).toBe(
      registered.id
    )
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBe(dataHome)
    expect((await service.select(provider, registered.id.toUpperCase())).activeAccountId).toBe(
      registered.id
    )
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBe(dataHome)
  })
})
