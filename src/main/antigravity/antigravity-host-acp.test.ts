import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { selectAcpHostAccountHome } from '../acp/launch/acp-launch-command'
import type { AcpHostBackendSettings } from '../acp/launch/acp-launch-contract'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

// agy's own sign-in, read from the host's keyring or token file.
const agyCredential = vi.hoisted(() => ({ present: true }))
vi.mock('./native-credential-backend', () => ({
  createAntigravityHostCredentialBackend: () => ({
    read: async () => (agyCredential.present ? { contents: '{}' } : null),
    write: async () => {}
  }),
  isAntigravityFileStorageHost: () => false
}))
vi.mock('./native-macos-credentials', () => ({
  hasAntigravityMacOSCredential: async () => agyCredential.present
}))

// Trimmed from `agy acp` 1.5.2's initialize response.
const HOST_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
    auth: { logout: {} }
  },
  agentInfo: { name: 'Antigravity ACP Server', version: '1.5.2' },
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }]
}

const folders: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

const SIGNED_IN_LIST = { result: { sessions: [] } }
// What `agy acp` 1.5.3 answers session requests with when its silent sign-in fails.
const SIGNED_OUT_LIST = { error: { code: -32000, message: 'Authentication required' } }

/** A PATH folder whose `agy acp` answers initialize with `result`, session/list with `list`. */
async function fakeAgy(
  result: unknown,
  list: unknown = SIGNED_IN_LIST,
  flags = ['--dangerously-skip-permissions']
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'orca-agy-host-test-'))
  folders.push(folder)
  const agy = join(folder, 'agy')
  await writeFile(
    agy,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(join(folder, 'launches'))}, 'x')
if (process.argv[2] !== 'acp') process.exit(2)
// agy rejects flags it does not define.
if (process.argv.slice(3).some((flag) => !${JSON.stringify(flags)}.includes(flag))) process.exit(2)
const result = ${JSON.stringify(result)}
const list = ${JSON.stringify(list)}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line)
  const reply = method === 'initialize' ? { result } : method === 'session/list' ? list : null
  if (reply) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n')
})
`
  )
  await chmod(agy, 0o755)
  return folder
}

it.skipIf(process.platform === 'win32')(
  "new chats pin the host's agy only when it is compatible, signed in, and Orca's Chat is not",
  async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-state-test-'))
    folders.push(stateDirectory)
    // An empty home, so agy's settings there select no API-key provider.
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-home-test-'))
    folders.push(home)
    const select = async (result: unknown, list?: unknown, flags?: string[]) =>
      selectAcpHostAccountHome(
        ANTIGRAVITY_LAUNCH_SPEC,
        { PATH: await fakeAgy(result, list, flags), HOME: home },
        stateDirectory,
        {}
      )
    await expect(select(HOST_INITIALIZE)).resolves.toEqual({
      variable: 'GEMINI_HOME',
      path: join(home, '.gemini')
    })
    const older = {
      ...HOST_INITIALIZE,
      agentInfo: { ...HOST_INITIALIZE.agentInfo, version: '1.5.1' }
    }
    await expect(select(older)).resolves.toBeNull()
    const managed = { ...HOST_INITIALIZE, agentInfo: { name: 'antigravity-acp', version: '1.5.2' } }
    await expect(select(managed)).resolves.toBeNull()
    // Full access chats launch with the flag, so a build without it keeps chats on Orca's runtime.
    await expect(select(HOST_INITIALIZE, SIGNED_IN_LIST, [])).resolves.toBeNull()
    await expect(
      selectAcpHostAccountHome(
        ANTIGRAVITY_LAUNCH_SPEC,
        { PATH: '', HOME: '/nowhere' },
        stateDirectory,
        {}
      )
    ).resolves.toBeNull()

    agyCredential.present = false
    await expect(select(HOST_INITIALIZE)).resolves.toBeNull()
    agyCredential.present = true
    // A keychain item agy cannot sign in from silently.
    await expect(select(HOST_INITIALIZE, SIGNED_OUT_LIST)).resolves.toBeNull()

    // Someone already signed in to Orca's own Chat keeps it.
    const managedAcp = join(stateDirectory, 'antigravity-chat', 'antigravity-acp')
    await mkdir(managedAcp, { recursive: true })
    await expect(select(HOST_INITIALIZE)).resolves.not.toBeNull()
    await writeFile(join(managedAcp, 'acp_token.json'), '{}')
    await expect(select(HOST_INITIALIZE)).resolves.toBeNull()
  }
)

it.skipIf(process.platform === 'win32')(
  "a saved Gemini Enterprise choice keeps new chats on Orca's runtime",
  async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-state-test-'))
    folders.push(stateDirectory)
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-home-test-'))
    folders.push(home)
    const shellEnv = { PATH: await fakeAgy(HOST_INITIALIZE), HOME: home }
    const select = (settings: AcpHostBackendSettings) =>
      selectAcpHostAccountHome(ANTIGRAVITY_LAUNCH_SPEC, shellEnv, stateDirectory, settings)
    await expect(
      select({ antigravityChatAuth: { method: 'oauth-personal' } })
    ).resolves.not.toBeNull()
    await expect(
      select({
        antigravityChatAuth: { method: 'oauth-business', gcpProject: 'acme', gcpLocation: 'us' }
      })
    ).resolves.toBeNull()
    // A saved file can hold an incomplete choice the types rule out.
    await expect(
      select(JSON.parse('{"antigravityChatAuth":{"method":"oauth-business"}}'))
    ).resolves.toBeNull()
  }
)

it.skipIf(process.platform === 'win32')(
  "agy's API-key mode keeps new chats on Orca's runtime, since host chats drop the key",
  async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const stateDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-state-test-'))
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-home-test-'))
    folders.push(stateDirectory, home)
    const settingsFolder = join(home, '.gemini', 'antigravity-cli')
    await mkdir(settingsFolder, { recursive: true })
    const shellEnv = { PATH: await fakeAgy(HOST_INITIALIZE), HOME: home }
    const select = async (settings: string) => {
      await writeFile(join(settingsFolder, 'settings.json'), settings)
      return selectAcpHostAccountHome(ANTIGRAVITY_LAUNCH_SPEC, shellEnv, stateDirectory, {})
    }
    await expect(select('{"model":"Gemini 4 Argon (Medium)"}')).resolves.not.toBeNull()
    await expect(select('{"modelProvider":"gemini"}')).resolves.toBeNull()
  }
)
