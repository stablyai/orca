import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { CommandCodeAccountService } from './service'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-command-code-accounts-'))
  roots.push(root)
  return root
}

function createStore(overrides: Partial<GlobalSettings> = {}) {
  let settings = { ...getDefaultSettings('/home/test'), ...overrides }
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
}

function createSourceHome(root: string): string {
  const home = join(root, 'source-commandcode')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ apiKey: 'cc-secret-key', userName: 'work-user', userId: 'provider-user' }),
    { mode: 0o600 }
  )
  writeFileSync(join(home, 'settings.json'), '{"theme":"dark"}')
  mkdirSync(join(home, 'projects'), { recursive: true })
  writeFileSync(join(home, 'projects', 'session.jsonl'), 'private session')
  return home
}

function createService(store: ReturnType<typeof createStore>, root: string) {
  return new CommandCodeAccountService(store, join(root, 'managed'))
}

describe('CommandCodeAccountService', () => {
  it('imports only auth.json and exposes no credential path or API key', async () => {
    const root = tempRoot()
    const store = createStore()
    const state = await createService(store, root).addAccountFromHome(
      createSourceHome(root),
      'Work'
    )

    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]).toMatchObject({ label: 'Work', userName: 'work-user' })
    expect(state.accounts[0]).not.toHaveProperty('managedAuthPath')
    expect(JSON.stringify(state)).not.toContain('cc-secret-key')
    const stored = store.getSettings().commandCodeManagedAccounts![0]
    expect(readFileSync(stored.managedAuthPath, 'utf-8')).toContain('cc-secret-key')
    expect(() => statSync(join(stored.managedAuthPath, '..', 'settings.json'))).toThrow()
    expect(() => statSync(join(stored.managedAuthPath, '..', 'projects'))).toThrow()
    if (process.platform !== 'win32') {
      expect(statSync(stored.managedAuthPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(stored.managedAuthPath, '..')).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps the selected source home unchanged', async () => {
    const root = tempRoot()
    const source = createSourceHome(root)
    const before = readFileSync(join(source, 'auth.json'), 'utf-8')

    await createService(createStore(), root).addAccountFromHome(source, 'Personal')

    expect(readFileSync(join(source, 'auth.json'), 'utf-8')).toBe(before)
    expect(readFileSync(join(source, 'projects', 'session.jsonl'), 'utf-8')).toBe('private session')
  })

  it('selects, renames, and removes only an owned managed credential', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = createService(store, root)
    const added = await service.addAccountFromHome(createSourceHome(root), 'Work')
    const accountId = added.accounts[0].id
    const managedAuth = store.getSettings().commandCodeManagedAccounts![0].managedAuthPath

    expect(service.getSelectedApiKey()).toBe('cc-secret-key')
    expect((await service.selectAccount(null)).activeAccountId).toBeNull()
    expect(service.getSelectedApiKey()).toBeNull()
    expect((await service.selectAccount(accountId)).activeAccountId).toBe(accountId)
    expect((await service.renameAccount(accountId, 'Renamed')).accounts[0].label).toBe('Renamed')
    expect((await service.removeAccount(accountId)).accounts).toEqual([])
    expect(() => statSync(managedAuth)).toThrow()
  })

  it('refuses removal after the ownership marker changes', async () => {
    const root = tempRoot()
    const store = createStore()
    const service = createService(store, root)
    const added = await service.addAccountFromHome(createSourceHome(root), 'Work')
    const stored = store.getSettings().commandCodeManagedAccounts![0]
    writeFileSync(
      join(stored.managedAuthPath, '..', '.orca-managed-command-code-account'),
      'different-account\n'
    )

    await expect(service.removeAccount(added.accounts[0].id)).rejects.toThrow(/marker/i)
    expect(statSync(stored.managedAuthPath).isFile()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link auth file', async () => {
    const root = tempRoot()
    const source = createSourceHome(root)
    const authPath = join(source, 'auth.json')
    const outside = join(root, 'outside-auth.json')
    writeFileSync(outside, readFileSync(authPath))
    const { unlinkSync } = await import('node:fs')
    unlinkSync(authPath)
    symlinkSync(outside, authPath)

    await expect(
      createService(createStore(), root).addAccountFromHome(source, 'Work')
    ).rejects.toThrow(/symbolic link/i)
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing API key', '{}'],
    ['multiline API key', '{"apiKey":"line\\nbreak"}'],
    ['an oversized auth file', JSON.stringify({ apiKey: 'x'.repeat(1024 * 1024) })]
  ])('rejects %s', async (_name, contents) => {
    const root = tempRoot()
    const source = createSourceHome(root)
    writeFileSync(join(source, 'auth.json'), contents)

    await expect(
      createService(createStore(), root).addAccountFromHome(source, 'Work')
    ).rejects.toThrow()
  })

  it.each(['', '   ', 'line\nbreak', 'x'.repeat(121)])(
    'rejects invalid labels %#',
    async (label) => {
      const root = tempRoot()
      await expect(
        createService(createStore(), root).addAccountFromHome(createSourceHome(root), label)
      ).rejects.toThrow(/label/i)
    }
  )
})
