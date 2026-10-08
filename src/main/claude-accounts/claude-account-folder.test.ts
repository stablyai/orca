import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const keychain = vi.hoisted(() => ({ items: new Map<string, number>(), userHome: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => keychain.userHome
}))
vi.mock('../macos-keychain/generic-password', () => ({
  execSecurityCommand: async (args: string[]) => {
    const service = args[2]
    const count = keychain.items.get(service) ?? 0
    if (count === 0) {
      throw new Error('The specified item could not be found in the keychain.')
    }
    keychain.items.set(service, count - 1)
    return { stdout: '', stderr: '' }
  }
}))

import { readClaudeFolderLogin, removeClaudeAccountFolder } from './claude-account-folder'
import { claudeKeychainService } from './keychain'

const roots: string[] = []
afterEach(() => {
  keychain.items.clear()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-account-folder-'))
  roots.push(root)
  keychain.userHome = root
  const dataRoot = join(root, 'data')
  const home = join(dataRoot, 'claude-profiles', 'a', 'home')
  mkdirSync(home, { recursive: true })
  return { root, dataRoot, home }
}

describe('claude account folder', () => {
  it("reads the folder's login and treats a signed-out state file as no login", () => {
    const { home } = fixture()
    const stateFile = join(home, '.claude.json')
    expect(readClaudeFolderLogin(stateFile)).toBeNull()
    writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: ' a@example.test ' } }))
    expect(readClaudeFolderLogin(stateFile)).toEqual({
      email: 'a@example.test',
      organizationUuid: null,
      organizationName: null
    })
    writeFileSync(stateFile, JSON.stringify({ numStartups: 2 }))
    expect(readClaudeFolderLogin(stateFile)).toBeNull()
  })

  it('reuses a recent answer within maxAgeMs even though the file changed', () => {
    const { home } = fixture()
    const stateFile = join(home, '.claude.json')
    writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }))
    expect(readClaudeFolderLogin(stateFile, 5_000)?.email).toBe('a@example.test')
    writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test!' } }))
    expect(readClaudeFolderLogin(stateFile, 5_000)?.email).toBe('a@example.test')
    expect(readClaudeFolderLogin(stateFile)?.email).toBe('b@example.test!')
  })

  // A real symlink needs Developer Mode on Windows (EPERM otherwise).
  it.skipIf(process.platform === 'win32')(
    'unlinks shared history before deleting, and leaves the older layout alone',
    async () => {
      const { root, dataRoot, home } = fixture()
      const history = join(root, '.claude', 'projects')
      mkdirSync(history, { recursive: true })
      writeFileSync(join(history, 'chat.jsonl'), '{}')
      symlinkSync(history, join(home, 'projects'))
      const older = join(dataRoot, 'claude-accounts', 'a')
      mkdirSync(older, { recursive: true })

      await removeClaudeAccountFolder(dataRoot, 'a')
      expect(existsSync(join(dataRoot, 'claude-profiles', 'a'))).toBe(false)
      expect(existsSync(join(history, 'chat.jsonl'))).toBe(true)
      expect(existsSync(older)).toBe(true)
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'deletes every Keychain item Claude may have keyed to the folder',
    async () => {
      const { dataRoot, home } = fixture()
      const rest = home.slice(keychain.userHome.length)
      const spellings = [home, `${home}/`, `~${rest}`, `$HOME${rest}/`]
      for (const spelling of spellings) {
        keychain.items.set(claudeKeychainService(spelling), 2)
      }
      const unrelated = claudeKeychainService(join(keychain.userHome, 'other'))
      keychain.items.set(unrelated, 1)

      await removeClaudeAccountFolder(dataRoot, 'a')
      for (const spelling of spellings) {
        expect(keychain.items.get(claudeKeychainService(spelling))).toBe(0)
      }
      expect(keychain.items.get(unrelated)).toBe(1)
    }
  )
})
