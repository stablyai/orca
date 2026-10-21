import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getManagedCommand } from '../../main/codex/codex-hook-definition'
import { _internals as grantInternals } from '../../main/codex/codex-hook-trust-grant'

const { homes, call } = vi.hoisted(() => ({
  homes: { current: '' },
  call: vi.fn<() => Promise<unknown>>()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => homes.current }
})
vi.mock('electron', () => ({
  app: { getPath: () => process.env.ORCA_USER_DATA_PATH }
}))
vi.mock('../runtime-client', () => ({
  RuntimeClient: class {
    call = call
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => process.env.ORCA_USER_DATA_PATH
}))

import { main } from '../index'

const SCRIPT_NAME = process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
let root: string
let appHome: string
let realHome: string
let managedHome: string

// Why: stand in for a missing codex binary so no real app-server ever starts.
function stubMissingCodexBinary(): never {
  throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
}

function listTree(dir: string): Map<string, { bytes: string; mtimeMs: number }> {
  const files = new Map<string, { bytes: string; mtimeMs: number }>()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        files.set(relative(dir, path), {
          bytes: readFileSync(path, 'utf-8'),
          mtimeMs: statSync(path).mtimeMs
        })
      }
    }
  }
  walk(dir)
  return files
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-prepare-codex-isolated-home-'))
  appHome = join(root, 'app-home')
  const appUserData = join(root, 'app-user-data')
  realHome = join(root, 'real-home')
  managedHome = join(appUserData, 'codex-runtime-home', 'home')
  mkdirSync(managedHome, { recursive: true })
  // The app, running with its own HOME, installed the pane's home at spawn.
  const appCommand = getManagedCommand(join(appHome, '.orca', 'agent-hooks', SCRIPT_NAME))
  writeFileSync(
    join(managedHome, 'hooks.json'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: appCommand }] }] } }, null, 2)}\n`
  )
  for (const home of [appHome, realHome]) {
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, '.codex', 'hooks.json'), '{\n  "hooks": {}\n}\n')
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "user-model"\n')
    writeFileSync(join(home, '.orca', 'agent-hooks', SCRIPT_NAME), '# another Orca wrote this\n')
  }
  vi.stubEnv('ORCA_USER_DATA_PATH', appUserData)
  vi.stubEnv('CODEX_HOME', managedHome)
  vi.stubEnv('ORCA_CODEX_HOME', managedHome)
  vi.stubEnv('WSL_DISTRO_NAME', '')
  grantInternals.setGrantSessionRunner(stubMissingCodexBinary)
})

afterEach(() => {
  call.mockReset()
  grantInternals.setGrantSessionRunner(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
  rmSync(root, { recursive: true, force: true })
})

// Why: the pane shell can run under the real HOME (login(1)) or the app's own;
// on a native host the pane step neither writes a Codex home nor asks the app to.
it.each([
  ['the real HOME', 'real'],
  ["the app's HOME", 'app']
])('writes nothing from a pane under %s', async (_case, paneHome) => {
  homes.current = paneHome === 'real' ? realHome : appHome
  call.mockResolvedValue({ result: null })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const before = [realHome, appHome, managedHome].map(listTree)

  await main(['agent', 'hooks', 'prepare-codex'])

  expect(process.exitCode).toBeUndefined()
  expect(call).not.toHaveBeenCalled()
  expect([realHome, appHome, managedHome].map(listTree)).toEqual(before)
})
