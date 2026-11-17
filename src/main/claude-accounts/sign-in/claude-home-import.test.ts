import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importClaudeHome } from './claude-home-import'
import { claudeStateFile } from './claude-account-folder'
import { provisionClaudeAccountProfile } from '../profiles/setup/claude-profile-setup'
import { describeClaudeProfile } from '../profiles/claude-profile-paths'

vi.mock('../runtime-auth/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: async () => null,
  writeClaudeProfileKeychainCredentials: async () => {},
  claudeConfigDirSpellings: () => [],
  claudeKeychainService: () => 'test'
}))
let root: string
let source: string
let destination: string
let defaultHome: string
const credentials =
  '{"claudeAiOauth":{"accessToken":"fake-import-token","refreshToken":"fake-refresh-token"}}'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-import-'))
  source = join(root, 'source')
  destination = join(root, 'account')
  defaultHome = join(root, 'user', '.claude')
  for (const path of [source, destination, defaultHome]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(
    claudeStateFile(source),
    '{"oauthAccount":{"emailAddress":"work@example.test","organizationUuid":"work-org"},"projects":{"untrusted":"do-not-import"}}'
  )
  writeFileSync(join(source, '.credentials.json'), credentials)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('imports a private account and history without changing the source or copying project trust', async () => {
  mkdirSync(join(source, 'projects', 'client'), { recursive: true })
  writeFileSync(join(source, 'projects', 'client', 'session.jsonl'), 'work conversation')
  writeFileSync(join(source, 'history.jsonl'), 'work prompt')
  writeFileSync(join(source, 'settings.json'), '{"apiKeyHelper":"source-command"}')
  await importClaudeHome(source, destination, defaultHome, true)
  expect(JSON.parse(readFileSync(claudeStateFile(destination), 'utf8')).oauthAccount).toEqual({
    emailAddress: 'work@example.test',
    organizationUuid: 'work-org'
  })
  expect(JSON.parse(readFileSync(claudeStateFile(destination), 'utf8')).projects).toBeUndefined()
  expect(readFileSync(join(destination, 'projects', 'client', 'session.jsonl'), 'utf8')).toBe(
    'work conversation'
  )
  expect(readFileSync(join(destination, 'history.jsonl'), 'utf8')).toBe('work prompt')
  expect(existsSync(join(destination, 'settings.json'))).toBe(false)
  if (process.platform !== 'darwin') {
    expect(readFileSync(join(destination, '.credentials.json'), 'utf8')).toBe(credentials)
  }
  writeFileSync(join(destination, 'projects', 'client', 'session.jsonl'), 'new work conversation')
  expect(readFileSync(join(source, 'projects', 'client', 'session.jsonl'), 'utf8')).toBe(
    'work conversation'
  )
  expect(readFileSync(join(source, '.credentials.json'), 'utf8')).toBe(credentials)
})

it('keeps imported history private across subsequent setup and detaches prior shared links', async () => {
  const dataRoot = join(root, 'data')
  const profile = describeClaudeProfile(dataRoot, 'work', {
    runtime: 'host',
    executionHostId: 'local'
  })
  mkdirSync(profile.home, { recursive: true })
  mkdirSync(join(defaultHome, 'projects'))
  writeFileSync(join(defaultHome, 'projects', 'personal.jsonl'), 'personal conversation')
  writeFileSync(join(defaultHome, 'history.jsonl'), 'personal prompt')
  symlinkSync(
    join(defaultHome, 'projects'),
    join(profile.home, 'projects'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  linkSync(join(defaultHome, 'history.jsonl'), join(profile.home, 'history.jsonl'))
  await importClaudeHome(source, profile.home, defaultHome, false)
  await provisionClaudeAccountProfile({
    dataRoot,
    profile,
    userHome: join(root, 'user'),
    installHooks: null
  })
  expect(lstatSync(join(profile.home, 'projects')).isSymbolicLink()).toBe(false)
  expect(existsSync(join(profile.home, 'projects', 'personal.jsonl'))).toBe(false)
  writeFileSync(join(profile.home, 'history.jsonl'), 'work prompt')
  expect(readFileSync(join(defaultHome, 'history.jsonl'), 'utf8')).toBe('personal prompt')
  expect(readFileSync(join(defaultHome, 'projects', 'personal.jsonl'), 'utf8')).toBe(
    'personal conversation'
  )
})

it('rejects linked source history without copying credentials', async () => {
  mkdirSync(join(defaultHome, 'projects'))
  symlinkSync(
    join(defaultHome, 'projects'),
    join(source, 'projects'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(importClaudeHome(source, destination, defaultHome, true)).rejects.toThrow(
    'contains links'
  )
  expect(existsSync(join(destination, '.credentials.json'))).toBe(false)
})
