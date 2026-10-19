import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as filesystem from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import * as secureFile from '../../shared/secure-file'
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
  service = new ManagedDataAccountService(join(root, 'managed'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe.each(['opencode', 'devin'] as const)('committed %s enrollment', (provider) => {
  it.each(['after write', 'unrestricted'])(
    'keeps captured credentials when metadata persistence reports %s failure',
    async (failure) => {
      const metadata = join(root, 'managed', provider, 'accounts.json')
      const write = secureFile.writeSecureFile
      vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
        const result = write(...args)
        if (args[0] !== metadata) {
          return result
        }
        if (failure === 'unrestricted') {
          return false
        }
        throw new Error('post-publication write failure')
      })
      await expect(service.add(provider, source, 'Work')).rejects.toThrow(
        failure === 'unrestricted' ? 'metadata permissions' : 'post-publication'
      )
      const state = service.list(provider)
      expect(state.accounts).toHaveLength(1)
      expect(state.activeAccountId).toBe(state.accounts[0].id)
      const directory = join(root, 'managed', provider, state.accounts[0].id)
      expect(existsSync(directory)).toBe(true)
      expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBe(join(directory, 'data'))
    }
  )

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

  it('keeps credentials when published metadata is unreadable', async () => {
    const metadata = join(root, 'managed', provider, 'accounts.json')
    const write = secureFile.writeSecureFile
    let published = ''
    vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
      const result = write(...args)
      if (args[0] !== metadata) {
        return result
      }
      published = readFileSync(metadata, 'utf8')
      writeFileSync(metadata, '{')
      throw new Error('post-publication metadata unreadable')
    })
    await expect(service.add(provider, source, 'Work')).rejects.toThrow('metadata unreadable')
    expect(
      readdirSync(join(root, 'managed', provider)).filter((name) => name !== 'accounts.json')
    ).toHaveLength(1)
    writeFileSync(metadata, published)
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBeTruthy()
  })

  it('keeps credentials when metadata existence cannot be checked', async () => {
    const metadata = join(root, 'managed', provider, 'accounts.json')
    const write = secureFile.writeSecureFile
    const exists = filesystem.existsSync
    const stat = filesystem.lstatSync
    let inaccessible = false
    vi.spyOn(filesystem, 'existsSync').mockImplementation((path) =>
      inaccessible && path === metadata ? false : exists(path)
    )
    vi.spyOn(filesystem, 'lstatSync').mockImplementation((...args) => {
      if (inaccessible && args[0] === metadata) {
        throw Object.assign(new Error('Metadata access denied'), { code: 'EACCES' })
      }
      return stat(...args)
    })
    vi.spyOn(secureFile, 'writeSecureFile').mockImplementation((...args) => {
      const result = write(...args)
      if (args[0] !== metadata) {
        return result
      }
      inaccessible = true
      return false
    })
    await expect(service.add(provider, source, 'Work')).rejects.toThrow('metadata permissions')
    inaccessible = false
    const state = service.list(provider)
    expect(exists(join(root, 'managed', provider, state.accounts[0].id))).toBe(true)
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBeTruthy()
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

  it('selects the registered UUID spelling and searches its transcript first', async () => {
    const personal = (await service.add(provider, source, 'Personal')).accounts[0]
    const work = (await service.add(provider, source, 'Work')).accounts[1]
    const selected = await service.select(provider, work.id.toUpperCase())
    expect(selected.activeAccountId).toBe(work.id)
    expect(service.list(provider).activeAccountId).toBe(work.id)
    expect(
      service.transcriptEnvironments(provider).map((environment) => environment.XDG_DATA_HOME)
    ).toEqual(
      [work, personal].map((account) =>
        join(root, 'managed', provider, account.id.toLowerCase(), 'data')
      )
    )
  })

  it('isolates a throwing listener after enrollment has committed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.onChanged(() => {
      throw new Error('private-listener-detail')
    })
    const healthy = vi.fn()
    service.onChanged(healthy)
    const state = await service.add(provider, source, 'Work')
    expect(service.list(provider)).toEqual(state)
    expect(service.launchEnvironment(provider).XDG_DATA_HOME).toBeTruthy()
    expect(healthy).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private-listener-detail')
  })
})
