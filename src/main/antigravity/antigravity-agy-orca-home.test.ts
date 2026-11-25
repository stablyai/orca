import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AntigravityChatAuthConfigSchema,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

// No key is saved in Orca's store.
vi.mock('./antigravity-chat-api-key-store', () => ({ hasAntigravityChatApiKey: async () => false }))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { acpLaunchSpecForAccount } = await import('../acp/launch/acp-launch-command')
const { antigravityAgyOrcaAccount } = await import('./antigravity-agy-orca-home')
const { AcpListingRefused } = await import('../acp/discovery/acp-listing-account')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'agy-orca-home-'))
  folders.push(path)
  return path
}

function parsed(value: unknown): AntigravityChatAuthConfig {
  return AntigravityChatAuthConfigSchema.parse(value)
}

const args = (home: AgentSessionAccountHome) =>
  acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, home).args({ fullAccess: false, pluginDirs: [] })

it.each([
  ['a Google account', { method: 'oauth-personal' }, 'own'],
  ['Gemini Enterprise', { method: 'oauth-business', gcpProject: 'p', gcpLocation: 'l' }, 'orca'],
  ['a Gemini API key', { method: 'gemini-api-key' }, 'orca'],
  ['gcloud', { method: 'agent-platform', gcpProject: 'p' }, 'orca']
])('runs new %s chats on agy, in the home the method alone picks', async (_case, auth, where) => {
  const homePath = folder()
  const stateDirectory = folder()
  // Nothing is installed or signed in: the answer never waits on agy.
  const home = await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.select({
    command: 'agy',
    env: { PATH: '' },
    envToDelete: [],
    homePath,
    stateDirectory,
    settings: { antigravityChatAuth: parsed(auth) },
    startsProgram: true
  })
  const orcaHome = join(stateDirectory, 'antigravity-agy-chat')
  expect(home).toEqual({
    variable: 'GEMINI_HOME',
    path: where === 'own' ? join(homePath, '.gemini') : orcaHome
  })
  expect(args(home!)).toEqual(
    where === 'own'
      ? ['acp']
      : ['acp', '--gemini-dir', orcaHome, '--app-data-dir', 'antigravity-acp']
  )
})

it("resumes chats Orca's retired server started on agy, where they are", () => {
  const server = { variable: 'GEMINI_HOME', path: '/data/antigravity-chat' }
  expect(args(server)).toEqual([
    'acp',
    '--gemini-dir',
    '/data/antigravity-chat',
    '--app-data-dir',
    'antigravity-acp'
  ])
})

it("refuses a key chat with no key, and doesn't list for it", async () => {
  const home = folder()
  const env = { GEMINI_HOME: home, HOME: folder() }
  await expect(
    antigravityAgyOrcaAccount.prepare!(env, { method: 'gemini-api-key' })
  ).rejects.toMatchObject({
    reason: 'notSignedIn',
    account: 'managed',
    message: expect.stringContaining('No Gemini API key is saved')
  })
  await expect(
    antigravityAgyOrcaAccount.prepare!(env, { method: 'gemini-api-key' }, undefined, 'listing')
  ).rejects.toBeInstanceOf(AcpListingRefused)
  expect(existsSync(join(home, 'antigravity-acp', 'settings.json'))).toBe(false)
})

it("gives a Google method agy's login file and every other method none", async () => {
  const home = folder()
  const user = folder()
  const login = join(user, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(user, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(login, '{"refresh_token":"r"}')
  const copy = join(home, 'antigravity-acp', 'antigravity-oauth-token')
  const env = { GEMINI_HOME: home, HOME: user, GEMINI_API_KEY: 'k' }
  const enterprise = parsed({ method: 'oauth-business', gcpProject: 'p', gcpLocation: 'l' })
  await antigravityAgyOrcaAccount.prepare!(env, enterprise)
  expect(readFileSync(copy, 'utf8')).toBe('{"refresh_token":"r"}')
  expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"oauth-business"},"gcp":{"project":"p","location":"l"}}'
  )
  await antigravityAgyOrcaAccount.prepare!(env, { method: 'gemini-api-key' })
  expect(existsSync(copy)).toBe(false)
  expect(readFileSync(login, 'utf8')).toBe('{"refresh_token":"r"}')
})

it("brings the user's ~/.gemini rules and skills to agy's layout in the home", async () => {
  const home = folder()
  const user = folder()
  for (const skills of [['config', 'skills'], ['skills'], ['antigravity-cli', 'skills']]) {
    mkdirSync(join(user, '.gemini', ...skills, 'mine'), { recursive: true })
  }
  writeFileSync(join(user, '.gemini', 'GEMINI.md'), 'be brief')
  const env = { GEMINI_HOME: home, HOME: user, GEMINI_API_KEY: 'k' }
  await antigravityAgyOrcaAccount.prepare!(env, { method: 'gemini-api-key' })
  expect(readFileSync(join(home, 'GEMINI.md'), 'utf8')).toBe('be brief')
  expect(realpathSync(join(home, 'config', 'skills'))).toBe(
    realpathSync(join(user, '.gemini', 'config', 'skills'))
  )
  expect(realpathSync(join(home, 'skills'))).toBe(realpathSync(join(user, '.gemini', 'skills')))
  // agy's app data folder here is antigravity-acp, where ~/.gemini's is antigravity-cli.
  expect(realpathSync(join(home, 'antigravity-acp', 'skills'))).toBe(
    realpathSync(join(user, '.gemini', 'antigravity-cli', 'skills'))
  )
  rmSync(join(user, '.gemini', 'GEMINI.md'))
  await antigravityAgyOrcaAccount.prepare!(env, { method: 'gemini-api-key' })
  expect(existsSync(join(home, 'GEMINI.md'))).toBe(false)
})

it("removes only a model listing's own session, and only from agy's homes", async () => {
  const { discardAgyListingSession } = await import('./agy-listing-session-discard')
  const id = '1b17d8f7-7efa-4b20-8476-7d9ce7b27848'
  const other = '2c28e9f8-8fc0-4c31-9587-8e0df38c3959'
  const runAgent = async () => ''
  const make = (root: string, appData: string, session = id) => {
    mkdirSync(join(root, appData, 'conversations'), { recursive: true })
    writeFileSync(join(root, appData, 'conversations', `${session}.db`), '')
    return join(root, appData, 'conversations', `${session}.db`)
  }
  const orcaHome = join(folder(), 'antigravity-agy-chat')
  const ownHome = join(folder(), '.gemini')
  const legacy = join(folder(), 'antigravity-chat')
  const elsewhere = join(folder(), 'not-an-agy-home')
  const listed = [
    make(orcaHome, 'antigravity-acp'),
    make(ownHome, 'antigravity-cli'),
    make(legacy, 'antigravity-acp')
  ]
  const kept = [make(ownHome, 'antigravity-cli', other), make(elsewhere, 'antigravity-acp')]
  for (const accountHomePath of [orcaHome, ownHome, legacy, elsewhere]) {
    await discardAgyListingSession({ sessionId: id, cwd: '/tmp', accountHomePath, runAgent })
  }
  for (const path of listed) {
    expect(() => readFileSync(path)).toThrow()
  }
  for (const path of kept) {
    expect(readFileSync(path, 'utf8')).toBe('')
  }
})
