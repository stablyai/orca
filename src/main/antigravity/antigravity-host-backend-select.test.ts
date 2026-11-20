import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostAcp from './antigravity-host-acp'
import type { AgyCredentialPresence } from './agy-credential-presence'

const agy = vi.hoisted(
  (): { answer: HostAcp.AntigravityHostAcpAnswer; login: AgyCredentialPresence } => ({
    answer: 'ready',
    login: 'present'
  })
)
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  checkAntigravityHostAcp: async () => agy.answer
}))
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => agy.login }))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { answerAntigravityChatAuth } = await import('./antigravity-chat-account')
const { ANTIGRAVITY_ACP_COMMAND } = await import('./antigravity-acp-runtime')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => {
    chmodSync(path, 0o755)
    rmSync(path, { recursive: true, force: true })
  })
  Object.assign(agy, { answer: 'ready', login: 'present' })
})

type Host = {
  /** Orca's server release is installed. */
  server?: boolean
  /** Orca's server folder can't be read. */
  unreadableServer?: boolean
  /** A server of the user's own is on PATH. */
  serverOnPath?: boolean
  /** Orca's own Google sign-in was saved, whether or not the server is still installed. */
  orcaSignIn?: 'personal' | 'business'
  /** agy's own settings pick an API-key model provider. */
  agyApiKey?: boolean
  apiKeyChat?: boolean
  /** The agy that resolves is Orca's own copy. */
  orcasAgy?: boolean
  /** No agy is found on this host yet. */
  noAgy?: boolean
}

function host(options: Host = {}) {
  const homePath = mkdtempSync(join(tmpdir(), 'agy-home-'))
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-data-'))
  folders.push(homePath, stateDirectory)
  if (options.server) {
    const release = join(stateDirectory, 'agent-runtimes', 'antigravity', '1.5.0')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, '.install-complete.json'), '{}')
  }
  if (options.unreadableServer) {
    const root = join(stateDirectory, 'agent-runtimes', 'antigravity')
    mkdirSync(root, { recursive: true })
    chmodSync(root, 0)
    folders.unshift(root)
  }
  const bin = join(stateDirectory, 'bin')
  if (options.serverOnPath) {
    mkdirSync(bin)
    writeFileSync(join(bin, ANTIGRAVITY_ACP_COMMAND), '', { mode: 0o755 })
  }
  if (options.orcaSignIn) {
    const managed = join(stateDirectory, 'antigravity-chat', 'antigravity-acp')
    mkdirSync(managed, { recursive: true })
    const token = options.orcaSignIn === 'personal' ? 'acp_token.json' : 'acp_business_token.json'
    writeFileSync(join(managed, token), '{}')
  }
  if (options.agyApiKey) {
    const settings = join(homePath, '.gemini', 'antigravity-cli')
    mkdirSync(settings, { recursive: true })
    writeFileSync(join(settings, 'settings.json'), '{"modelProvider":"gemini-api-key"}')
  }
  return {
    command: options.noAgy
      ? 'agy'
      : options.orcasAgy
        ? join(stateDirectory, 'agent-runtimes', 'agy', '1.5.13', 'agy')
        : '/usr/local/bin/agy',
    env: { PATH: options.serverOnPath ? bin : '' },
    envToDelete: [],
    homePath,
    stateDirectory,
    settings: options.apiKeyChat
      ? { antigravityChatAuth: { method: 'gemini-api-key' as const } }
      : {}
  }
}

const { select, installsManagedRuntime } = ANTIGRAVITY_LAUNCH_SPEC.hostBackend

describe('Antigravity host backend selection', () => {
  it("runs new chats on a signed-in agy even when Orca's own Chat is signed in", async () => {
    const input = host({ orcaSignIn: 'personal' })
    answerAntigravityChatAuth(true)

    expect(await select(input)).toEqual({
      variable: 'GEMINI_HOME',
      path: join(input.homePath, '.gemini')
    })
  })

  it("runs new chats on a signed-out agy when Orca's server isn't in use, so agy asks to sign in", async () => {
    agy.answer = 'signedOut'
    const input = host()

    expect(await select(input)).toEqual({
      variable: 'GEMINI_HOME',
      path: join(input.homePath, '.gemini')
    })
  })

  it.each<[string, Host]>([
    ['Orca’s server is installed', { server: true }],
    ['Orca’s own sign-in is saved', { orcaSignIn: 'personal' }],
    ['the chat signs in with an API key', { apiKeyChat: true }],
    ['agy picks an API-key provider', { agyApiKey: true }]
  ])('keeps a signed-out agy out of new chats when %s', async (_case, options) => {
    agy.answer = 'signedOut'

    expect(await select(host(options))).toBeNull()
  })

  it('keeps an incompatible agy out of new chats', async () => {
    agy.answer = 'incompatible'

    expect(await select(host())).toBeNull()
  })

  it("runs new chats on an agy that didn't answer, since Install puts no server here", async () => {
    agy.answer = 'unanswered'
    const input = host()

    expect(await installsManagedRuntime(input)).toBe(false)
    expect(await select(input)).toEqual({
      variable: 'GEMINI_HOME',
      path: join(input.homePath, '.gemini')
    })
  })
})

describe('Antigravity install target', () => {
  it.each<[string, Host, HostAcp.AntigravityHostAcpAnswer, boolean]>([
    ['agy for a personal account', {}, 'signedOut', false],
    ['Orca’s server once installed', { server: true }, 'signedOut', true],
    [
      'Orca’s server after it was removed but its sign-in saved',
      { orcaSignIn: 'personal' },
      'signedOut',
      true
    ],
    ['Orca’s server for a saved business sign-in', { orcaSignIn: 'business' }, 'signedOut', true],
    ['Orca’s server when a server is on PATH', { serverOnPath: true }, 'signedOut', true],
    ['Orca’s server for an API-key chat', { apiKeyChat: true }, 'signedOut', true],
    ['Orca’s server when agy picks an API-key provider', { agyApiKey: true }, 'ready', true],
    ['Orca’s server when the host’s own agy is incompatible', {}, 'incompatible', true],
    ['Orca’s server when Orca’s own agy is incompatible', { orcasAgy: true }, 'incompatible', true]
  ])('installs %s', async (_case, options, answer, server) => {
    agy.answer = answer
    const input = host(options)

    expect(await installsManagedRuntime(input)).toBe(server)
  })
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "installs Orca's server when its folder can't be read, failing closed",
  async () => {
    agy.answer = 'signedOut'

    expect(await installsManagedRuntime(host({ unreadableServer: true }))).toBe(true)
  }
)

it('retires remembered routes once agy is checked again', async () => {
  const { forgetAntigravityHostAcpChecks } = await import('./antigravity-host-acp')
  const before = ANTIGRAVITY_LAUNCH_SPEC.hostBackend.selectionRevision()

  forgetAntigravityHostAcpChecks()

  expect(ANTIGRAVITY_LAUNCH_SPEC.hostBackend.selectionRevision()).not.toBe(before)
})

describe('a fresh host with neither agy nor Orca’s server', () => {
  it('pins the first chat to agy and installs agy, so the chat offers the Install it needs', async () => {
    const input = host({ noAgy: true })

    expect(await select(input)).toEqual({
      variable: 'GEMINI_HOME',
      path: join(input.homePath, '.gemini')
    })
    expect(await installsManagedRuntime(input)).toBe(false)
  })

  it('still reports the host program missing, so menus offer Install rather than a chat on agy', async () => {
    const { acpHostProgramTakesNewChats, selectAcpHostAccountHome } =
      await import('../acp/launch/acp-launch-command')
    const { homePath, stateDirectory } = host()
    const shell = { PATH: '', HOME: homePath, USERPROFILE: homePath }

    expect(
      await selectAcpHostAccountHome(ANTIGRAVITY_LAUNCH_SPEC, shell, stateDirectory, {})
    ).not.toBeNull()
    expect(
      await acpHostProgramTakesNewChats(ANTIGRAVITY_LAUNCH_SPEC, shell, stateDirectory, {})
    ).toBe(false)
  })
})

describe('agy behind a keyring that needs unlocking', () => {
  it('runs new chats on agy without asking it, so no unlock dialog appears', async () => {
    // Asking would answer incompatible and move chats to Orca's server.
    Object.assign(agy, { login: 'locked', answer: 'incompatible' })
    const input = host()

    expect(await installsManagedRuntime(input)).toBe(false)
    expect(await select(input)).not.toBeNull()
  })

  it("keeps new chats on Orca's server where agy has no login to find", async () => {
    Object.assign(agy, { login: 'absent', answer: 'ready' })

    expect(await select(host({ server: true }))).toBeNull()
  })
})
