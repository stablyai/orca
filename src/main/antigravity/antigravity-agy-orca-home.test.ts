import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostAcp from './antigravity-host-acp'
import type * as OrcaHome from './antigravity-agy-orca-home'
import {
  AntigravityChatAuthConfigSchema,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

const agy = vi.hoisted(() => ({ serves: true }))
// agy is installed and signed in to the person's own Google account.
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'present' }))
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  agyUsesApiKey: async () => false,
  checkAntigravityHostAcp: async () => 'ready',
  checkAntigravityHostAcpCompatible: async () => 'ready'
}))
vi.mock('./antigravity-agy-orca-home', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcaHome>()),
  agyServesOrcaHome: async () => agy.serves
}))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { acpLaunchSpecForAccount } = await import('../acp/launch/acp-launch-command')
const { antigravityAgyOrcaAccount } = await import('./antigravity-agy-orca-home')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  agy.serves = true
})

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'agy-orca-home-'))
  folders.push(path)
  return path
}

function parsed(value: unknown): AntigravityChatAuthConfig {
  return AntigravityChatAuthConfigSchema.parse(value)
}

async function select(antigravityChatAuth: unknown, { installed = true } = {}) {
  const homePath = folder()
  const stateDirectory = folder()
  const command = installed ? join(homePath, 'agy') : 'agy'
  if (installed) {
    writeFileSync(command, '')
  }
  const home = await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.select({
    command,
    env: { PATH: '' },
    envToDelete: [],
    homePath,
    stateDirectory,
    settings: { antigravityChatAuth: parsed(antigravityChatAuth) },
    startsProgram: true
  })
  return { home, homePath, stateDirectory }
}

it.each([
  ['a Gemini API key', { method: 'gemini-api-key' }],
  ['gcloud', { method: 'agent-platform', gcpProject: 'p' }]
])("runs %s chats on agy in a home Orca owns, never agy's own", async (_case, auth) => {
  const { home, stateDirectory } = await select(auth)
  expect(home).toEqual({
    variable: 'GEMINI_HOME',
    path: join(stateDirectory, 'antigravity-agy-chat')
  })
  const spec = acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, home!)
  expect(spec.command).toBe('agy')
  expect(spec.args({ fullAccess: false, pluginDirs: [] })).toEqual([
    'acp',
    '--gemini-dir',
    join(stateDirectory, 'antigravity-agy-chat'),
    '--app-data-dir',
    'antigravity-acp'
  ])
})

it("keeps key and gcloud chats on Orca's server where agy is missing or too old", async () => {
  expect((await select({ method: 'gemini-api-key' }, { installed: false })).home).toBeNull()
  agy.serves = false
  expect((await select({ method: 'agent-platform', gcpProject: 'p' })).home).toBeNull()
})

it('leaves Google-account and Enterprise routing as it was', async () => {
  const personal = await select({ method: 'oauth-personal' })
  expect(personal.home).toEqual({
    variable: 'GEMINI_HOME',
    path: join(personal.homePath, '.gemini')
  })
  const enterprise = await select({ method: 'oauth-business', gcpProject: 'p', gcpLocation: 'l' })
  expect(enterprise.home).toBeNull()
})

it("launches chats already on the server or agy's own home as before", () => {
  const server = { variable: 'GEMINI_HOME', path: '/data/antigravity-chat' }
  expect(acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, server)).toBe(ANTIGRAVITY_LAUNCH_SPEC)
  const own = acpLaunchSpecForAccount(ANTIGRAVITY_LAUNCH_SPEC, {
    variable: 'GEMINI_HOME',
    path: '/home/u/.gemini'
  })
  expect(own.args({ fullAccess: false, pluginDirs: [] })).toEqual(['acp'])
})

it('writes the saved method for agy, and refuses a key chat with no key, never a listing', async () => {
  const home = folder()
  const env = { GEMINI_HOME: home, HOME: folder() }
  await expect(
    antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' })
  ).rejects.toMatchObject({ reason: 'notSignedIn', account: 'managed' })
  await antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' }, undefined, 'listing')
  await antigravityAgyOrcaAccount.prepare(
    { ...env, GEMINI_API_KEY: 'k' },
    { method: 'gemini-api-key' }
  )
  expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"gemini-api-key"}}'
  )
  // gcloud is left to agy, whose ADC lookup only it can answer.
  await antigravityAgyOrcaAccount.prepare(env, {
    method: 'agent-platform',
    gcpProject: 'p',
    gcpLocation: 'global'
  })
  expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"agent-platform"},"gcp":{"project":"p","location":"global"}}'
  )
})

it("removes only a model listing's own session, and only in the home Orca owns", async () => {
  const { discardAgyOrcaListingSession } = await import('./antigravity-agy-orca-home')
  const id = '1b17d8f7-7efa-4b20-8476-7d9ce7b27848'
  const runAgent = async () => ''
  const make = (root: string) => {
    mkdirSync(join(root, 'antigravity-acp', 'conversations'), { recursive: true })
    writeFileSync(join(root, 'antigravity-acp', 'conversations', `${id}.db`), '')
    return join(root, 'antigravity-acp', 'conversations', `${id}.db`)
  }
  const orcaHome = join(folder(), 'antigravity-agy-chat')
  const ownHome = join(folder(), '.gemini')
  const listed = make(orcaHome)
  const kept = make(ownHome)
  await discardAgyOrcaListingSession({
    sessionId: id,
    cwd: '/tmp',
    accountHomePath: orcaHome,
    runAgent
  })
  await discardAgyOrcaListingSession({
    sessionId: id,
    cwd: '/tmp',
    accountHomePath: ownHome,
    runAgent
  })
  expect(() => readFileSync(listed)).toThrow()
  expect(readFileSync(kept, 'utf8')).toBe('')
})
