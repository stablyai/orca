import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { grantClaudeFolderTrust, grantClaudeWorkspaceTrust } from './claude-folder-trust-file'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(file: string, value: unknown, mode = 0o600): void {
  writeFileSync(file, JSON.stringify(value), { mode })
  chmodSync(file, mode)
}

function readConfig(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

describe('grantClaudeFolderTrust', () => {
  it('merges the key and keeps every other field', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] } }
    })
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'granted'
    )
    expect(readConfig(file)).toEqual({
      oauthAccount: { emailAddress: 'x' },
      mcpServers: { a: {} },
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: [] },
        '/wt': { hasTrustDialogAccepted: true }
      }
    })
  })

  it('keeps an owner-only mode through the rewrite', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {}, 0o600)
    await grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('leaves a corrupt file byte-for-byte untouched', async () => {
    const file = join(root, '.claude.json')
    writeFileSync(file, '{"oauthAccount": ', { mode: 0o600 })
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'unreadable'
    )
    expect(readFileSync(file, 'utf-8')).toBe('{"oauthAccount": ')
  })

  it('does nothing while Claude holds its lock, and leaves the lock in place', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    const lockDir = `${file}.lock`
    mkdirSync(lockDir)
    const oldTime = new Date(Date.now() - 60_000)
    // Exceed Claude's 10-second stale window to verify Orca leaves its lock intact.
    utimesSync(lockDir, oldTime, oldTime)
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'locked'
    )
    expect(readConfig(file)).toEqual({})
    expect(existsSync(lockDir)).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['.claude.json', '.claude.json.lock'])
  })

  it('updates a symlinked config through its target and keeps the link', async () => {
    const target = join(root, 'dotfiles-claude.json')
    const link = join(root, '.claude.json')
    writeConfig(target, { theme: 'dark' })
    symlinkSync(target, link)
    await grantClaudeFolderTrust({ configFile: link, folderKeys: ['/wt'] })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readConfig(target)).toEqual({
      theme: 'dark',
      projects: { '/wt': { hasTrustDialogAccepted: true } }
    })
  })

  it('grants every folder of a launch burst instead of losing some to its own lock', async () => {
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    const keys = Array.from({ length: 12 }, (_, index) => `/wt-${index}`)
    const outcomes = await Promise.all(
      keys.map((key) => grantClaudeFolderTrust({ configFile: file, folderKeys: [key] }))
    )
    expect(outcomes).toEqual(keys.map(() => 'granted'))
    expect(readConfig(file).projects).toEqual(
      Object.fromEntries(keys.map((key) => [key, { hasTrustDialogAccepted: true }]))
    )
  })
})

describe('grantClaudeWorkspaceTrust', () => {
  it('writes the given folder and its realpath form, whatever kind of folder it is', async () => {
    const real = join(root, 'real-folder')
    mkdirSync(real)
    const link = join(root, 'linked-folder')
    symlinkSync(real, link)
    const file = join(root, '.claude.json')
    writeConfig(file, {})
    await expect(
      grantClaudeWorkspaceTrust({ configFile: file, keyStyle: 'posix' }, link)
    ).resolves.toBe('granted')
    expect(readConfig(file)).toEqual({
      projects: {
        [link]: { hasTrustDialogAccepted: true },
        [real]: { hasTrustDialogAccepted: true }
      }
    })
  })
})
