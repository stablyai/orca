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
import type * as HostAcp from './antigravity-host-acp'
import type * as OrcaHome from './antigravity-agy-orca-home'
import type * as Credential from './antigravity-agy-orca-home-credential'
import {
  AntigravityChatAuthConfigSchema,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

// agy serves Orca's home, and a Gemini API key is here.
const agy = vi.hoisted(() => ({ serves: true, credential: true }))
// agy is installed and signed in to the person's own Google account.
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'present' }))
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  agyUsesApiKey: async () => false,
  checkAntigravityHostAcp: async () => 'ready',
  checkAntigravityHostAcpCompatible: async () => 'ready'
}))
// No key is saved in Orca's store.
vi.mock('./antigravity-chat-api-key-store', () => ({ hasAntigravityChatApiKey: async () => false }))
// Whether a Gemini API key is here (antigravity-agy-orca-home-credential.test.ts).
vi.mock('./antigravity-agy-orca-home-credential', async (importOriginal) => ({
  ...(await importOriginal<typeof Credential>()),
  agyOrcaHomeKeyPresent: async (env: Record<string, string>) =>
    agy.credential || env.GEMINI_API_KEY === 'shell-key'
}))
vi.mock('./antigravity-agy-orca-home', async (importOriginal) => ({
  ...(await importOriginal<typeof OrcaHome>()),
  agyServesOrcaHome: async () => agy.serves
}))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { acpLaunchSpecForAccount } = await import('../acp/launch/acp-launch-command')
const { antigravityAgyOrcaAccount } = await import('./antigravity-agy-orca-home')
const { AcpListingRefused } = await import('../acp/discovery/acp-listing-account')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  agy.serves = true
  agy.credential = true
})

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'agy-orca-home-'))
  folders.push(path)
  return path
}

function parsed(value: unknown): AntigravityChatAuthConfig {
  return AntigravityChatAuthConfigSchema.parse(value)
}

async function select(
  antigravityChatAuth: unknown,
  { installed = true, shellEnv }: { installed?: boolean; shellEnv?: Record<string, string> } = {}
) {
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
    ...(shellEnv ? { shellEnv } : {}),
    settings: { antigravityChatAuth: parsed(antigravityChatAuth) },
    startsProgram: true
  })
  return { home, homePath, stateDirectory }
}

it("runs Gemini API key chats on agy in a home Orca owns, never agy's own", async () => {
  const { home, stateDirectory } = await select({ method: 'gemini-api-key' })
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

it("keeps key chats on Orca's server where agy is missing or too old, or no key is here", async () => {
  expect((await select({ method: 'gemini-api-key' }, { installed: false })).home).toBeNull()
  agy.serves = false
  expect((await select({ method: 'gemini-api-key' })).home).toBeNull()
  agy.serves = true
  agy.credential = false
  expect((await select({ method: 'gemini-api-key' })).home).toBeNull()
})

it('finds a GEMINI_API_KEY the shell exports, which the host scrub drops for agy on its own home', async () => {
  agy.credential = false
  const shellEnv = { PATH: '', GEMINI_API_KEY: 'shell-key' }
  expect((await select({ method: 'gemini-api-key' }, { shellEnv })).home).not.toBeNull()
})

it("keeps gcloud chats on Orca's server, as on main, with agy and ADC here", async () => {
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

it("writes the key method for agy; without a key a chat is refused and a listing isn't run", async () => {
  const home = folder()
  const env = { GEMINI_HOME: home, HOME: folder() }
  agy.credential = false
  await expect(
    antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' })
  ).rejects.toMatchObject({
    reason: 'notSignedIn',
    account: 'managed',
    message: expect.stringContaining('No Gemini API key is saved')
  })
  await expect(
    antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' }, undefined, 'listing')
  ).rejects.toBeInstanceOf(AcpListingRefused)
  expect(existsSync(join(home, 'antigravity-acp', 'settings.json'))).toBe(false)
  agy.credential = true
  await antigravityAgyOrcaAccount.prepare(
    { ...env, GEMINI_API_KEY: 'k' },
    { method: 'gemini-api-key' }
  )
  expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"gemini-api-key"}}'
  )
})

it.each([
  ['gcloud', { method: 'agent-platform', gcpProject: 'p', gcpLocation: 'global' }],
  ['a Google account', { method: 'oauth-personal' }],
  ['Gemini Enterprise', { method: 'oauth-business', gcpProject: 'p', gcpLocation: 'l' }]
])(
  "refuses a chat pinned here once the method is %s, and never writes it for agy's own login",
  async (_case, auth) => {
    const home = folder()
    const env = { GEMINI_HOME: home, HOME: folder(), GEMINI_API_KEY: 'k' }
    await antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' })
    const config = parsed(auth)
    await expect(antigravityAgyOrcaAccount.prepare(env, config)).rejects.toMatchObject({
      reason: 'notSignedIn',
      message: expect.stringContaining('Start a new chat, or switch the sign-in method back')
    })
    await expect(
      antigravityAgyOrcaAccount.prepare(env, config, undefined, 'listing')
    ).rejects.toBeInstanceOf(AcpListingRefused)
    expect(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
      '{"auth":{"type":"gemini-api-key"}}'
    )
  }
)

it("brings the user's ~/.gemini rules and skills to agy's layout in the home", async () => {
  const home = folder()
  const user = folder()
  for (const skills of [['config', 'skills'], ['skills'], ['antigravity-cli', 'skills']]) {
    mkdirSync(join(user, '.gemini', ...skills, 'mine'), { recursive: true })
  }
  writeFileSync(join(user, '.gemini', 'GEMINI.md'), 'be brief')
  const env = { GEMINI_HOME: home, HOME: user, GEMINI_API_KEY: 'k' }
  await antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' })
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
  await antigravityAgyOrcaAccount.prepare(env, { method: 'gemini-api-key' })
  expect(existsSync(join(home, 'GEMINI.md'))).toBe(false)
})

it("reports Orca's server as what Install adds, so older clients keep the method form", async () => {
  const homePath = folder()
  const command = join(homePath, 'agy')
  writeFileSync(command, '')
  const input = {
    command,
    env: { PATH: '' },
    envToDelete: [],
    homePath,
    stateDirectory: folder(),
    settings: { antigravityChatAuth: parsed({ method: 'gemini-api-key' }) },
    startsProgram: true
  }
  expect(await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.installsManagedRuntime(input)).toBe(true)
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
