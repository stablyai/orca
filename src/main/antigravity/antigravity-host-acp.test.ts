import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { selectAcpHostAccountHome } from '../acp/acp-launch-command'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

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

/** A PATH folder whose `agy acp` answers initialize with `result`. */
async function fakeAgy(result: unknown): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'orca-agy-host-test-'))
  folders.push(folder)
  const agy = join(folder, 'agy')
  await writeFile(
    agy,
    `#!${process.execPath}
if (process.argv[2] !== 'acp') process.exit(2)
const result = ${JSON.stringify(result)}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
})
`
  )
  await chmod(agy, 0o755)
  return folder
}

it.skipIf(process.platform === 'win32')(
  "new chats pin the host's agy only when it answers as a compatible server",
  async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const select = async (result: unknown) =>
      selectAcpHostAccountHome(ANTIGRAVITY_LAUNCH_SPEC, {
        PATH: await fakeAgy(result),
        HOME: '/home/user'
      })
    await expect(select(HOST_INITIALIZE)).resolves.toEqual({
      variable: 'GEMINI_HOME',
      path: '/home/user/.gemini'
    })
    const older = {
      ...HOST_INITIALIZE,
      agentInfo: { ...HOST_INITIALIZE.agentInfo, version: '1.5.1' }
    }
    await expect(select(older)).resolves.toBeNull()
    const managed = { ...HOST_INITIALIZE, agentInfo: { name: 'antigravity-acp', version: '1.5.2' } }
    await expect(select(managed)).resolves.toBeNull()
    await expect(
      selectAcpHostAccountHome(ANTIGRAVITY_LAUNCH_SPEC, { PATH: '', HOME: '/nowhere' })
    ).resolves.toBeNull()
  }
)

it('a chat launches on the backend its account home pins', async () => {
  const resolve = (path: string) =>
    resolveAcpLaunchInvocation(
      ANTIGRAVITY_LAUNCH_SPEC,
      { variable: 'GEMINI_HOME', path },
      {
        resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
        resolveCommand: (command) => `/resolved/${command}`,
        dataDirectory: '/orca-data'
      }
    )
  const host = await resolve('/home/user/.gemini')
  expect(host.command).toBe('/resolved/agy')
  expect(host.spec.args({ fullAccess: false, pluginDir: null })).toEqual(['acp'])
  expect(host.env.GEMINI_HOME).toBeUndefined()
  expect(host.env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined()

  const managed = await resolve('/orca-data/antigravity-chat')
  expect(managed.spec.managedRuntime).toBeDefined()
  expect(managed.env.GEMINI_HOME).toBe('/orca-data/antigravity-chat')
  expect(managed.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
})
