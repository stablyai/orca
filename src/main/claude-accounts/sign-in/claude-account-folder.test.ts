import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const keychain = vi.hoisted(() => ({ items: new Map<string, number>(), userHome: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => keychain.userHome
}))
vi.mock('../../macos-keychain/generic-password', () => ({
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

import {
  readClaudeFolderLogin,
  readClaudeFolderLoginAsync,
  removeClaudeAccountFolder
} from './claude-account-folder'

import { claudeKeychainService } from '../runtime-auth/keychain'

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

it.each(['sync', 'async'] as const)(
  'refreshes shared login identity after an equal-metadata local replacement primed by %s',
  async (mode) => {
    const { root } = fixture()
    const state = join(root, '.claude.json')
    const staged = join(root, '.claude.next.json')
    const stamp = new Date('2025-01-01T00:00:00Z')
    writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }))
    utimesSync(state, stamp, stamp)
    const first =
      mode === 'sync' ? readClaudeFolderLogin(state) : await readClaudeFolderLoginAsync(state)
    expect(first?.email).toBe('a@example.test')
    writeFileSync(staged, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.test' } }))
    utimesSync(staged, stamp, stamp)
    renameSync(staged, state)
    expect(readClaudeFolderLogin(state)?.email).toBe('b@example.test')
    expect((await readClaudeFolderLoginAsync(state))?.email).toBe('b@example.test')
  }
)
