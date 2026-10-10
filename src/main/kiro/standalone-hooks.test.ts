import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import { KiroHookService } from './hook-service'
import { getKiroManagedCommandMatcher } from './hook-settings'
import {
  getKiroStandaloneHooksFilePath,
  KIRO_STANDALONE_HOOK_TRIGGERS
} from './standalone-hook-settings'
import {
  getKiroStandaloneHooksStatus,
  installKiroStandaloneHooks,
  removeKiroStandaloneHooks
} from './standalone-hooks'

// Why both names: os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows; setting
// only one would let a run edit the developer's real ~/.kiro or ~/.orca.
let home: string
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  KIRO_HOME: process.env.KIRO_HOME
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-kiro-standalone-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.KIRO_HOME
})

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  rmSync(home, { recursive: true, force: true })
})

type HooksFileEntry = { name: string; trigger: string; action: { type: string; command: string } }
type HooksFile = { version?: string; hooks?: HooksFileEntry[] }

const hooksFilePath = (): string => join(home, '.kiro', 'hooks', 'orca-agent-status.json')
const agentPath = (kiroHome: string, name: string): string =>
  join(kiroHome, 'agents', `${name}.json`)

// Why no assertion: `JSON.parse` is already `any`, so the annotation narrows without a cast.
function readHooksFile(): HooksFile {
  return JSON.parse(readFileSync(hooksFilePath(), 'utf-8'))
}

function writeHooksFile(content: string): void {
  mkdirSync(dirname(hooksFilePath()), { recursive: true })
  writeFileSync(hooksFilePath(), content)
}

function writeAgent(kiroHome: string, name: string): void {
  mkdirSync(join(kiroHome, 'agents'), { recursive: true })
  writeFileSync(agentPath(kiroHome, name), JSON.stringify({ name }))
}

const USER_HOOK = {
  name: 'mine',
  trigger: 'Stop',
  action: { type: 'command', command: 'notify.sh' }
}
const ORCA_HOOK = {
  name: 'orca-agent-status-Stop',
  trigger: 'Stop',
  action: { type: 'command', command: '/home/dev/.orca/agent-hooks/kiro-hook.sh' }
}

describe('Kiro V3 standalone hooks file', () => {
  it('reports not_installed before any install', () => {
    expect(getKiroStandaloneHooksStatus()).toMatchObject({
      agent: 'kiro',
      state: 'not_installed',
      managedHooksPresent: false
    })
  })

  it('installs the v1 file and its script under ~/.kiro even with no custom agent', () => {
    // The default-engine status stays primary: no agent to patch is still not_installed.
    expect(new KiroHookService().install().state).toBe('not_installed')

    expect(getKiroStandaloneHooksFilePath()).toBe(hooksFilePath())
    expect(getKiroStandaloneHooksStatus()).toMatchObject({ state: 'installed' })
    const file = readHooksFile()
    expect(file.version).toBe('v1')
    expect(file.hooks?.map((entry) => entry.trigger)).toEqual([...KIRO_STANDALONE_HOOK_TRIGGERS])
    const isManaged = getKiroManagedCommandMatcher()
    for (const entry of file.hooks ?? []) {
      expect(entry).toMatchObject({ name: `orca-agent-status-${entry.trigger}`, timeout: 10 })
      expect(entry.action.type).toBe('command')
      expect(isManaged(entry.action.command)).toBe(true)
    }
    const scriptName = process.platform === 'win32' ? 'kiro-hook.cmd' : 'kiro-hook.sh'
    expect(readFileSync(join(home, '.orca', 'agent-hooks', scriptName), 'utf-8')).toContain(
      '/hook/kiro'
    )
  })

  it('never registers the doc-only trigger names kiro-cli rejects', () => {
    installKiroStandaloneHooks('/home/dev/.orca/agent-hooks/kiro-hook.sh')
    const triggers = readHooksFile().hooks?.map((entry) => entry.trigger)
    expect(triggers).not.toContain('PromptSubmit')
    expect(triggers).not.toContain('AgentStop')
  })

  it('is idempotent — a second install leaves the file byte-identical', () => {
    const service = new KiroHookService()
    service.install()
    const first = readFileSync(hooksFilePath(), 'utf-8')
    service.install()
    expect(readFileSync(hooksFilePath(), 'utf-8')).toBe(first)
  })

  it('keeps the V3 file under ~/.kiro while KIRO_HOME relocates the V2 agents', () => {
    const kiroHome = join(home, 'custom-kiro')
    writeAgent(kiroHome, 'relocated')
    process.env.KIRO_HOME = kiroHome

    expect(new KiroHookService().install().state).toBe('installed')
    expect(existsSync(hooksFilePath())).toBe(true)
    expect(existsSync(join(kiroHome, 'hooks'))).toBe(false)
    expect(getKiroStandaloneHooksFilePath()).toBe(hooksFilePath())
  })

  it('reports partial when the managed file lost a trigger', () => {
    installKiroStandaloneHooks(ORCA_HOOK.action.command)
    const file = readHooksFile()
    writeHooksFile(
      JSON.stringify({ ...file, hooks: file.hooks?.filter((entry) => entry.trigger !== 'Stop') })
    )
    expect(getKiroStandaloneHooksStatus()).toMatchObject({
      state: 'partial',
      managedHooksPresent: true,
      detail: 'events: Stop'
    })
  })

  it('counts only the entries Kiro would run: a disabled entry is missing', () => {
    installKiroStandaloneHooks(ORCA_HOOK.action.command)
    const file = readHooksFile()
    writeHooksFile(
      JSON.stringify({
        ...file,
        hooks: file.hooks?.map((entry) =>
          entry.trigger === 'Stop' ? { ...entry, enabled: false } : entry
        )
      })
    )
    expect(getKiroStandaloneHooksStatus()).toMatchObject({
      state: 'partial',
      detail: 'events: Stop'
    })
  })

  it('reports a hooks file it cannot parse as an error and leaves it alone', () => {
    writeHooksFile('{ "version": "v1", "hooks": ')
    expect(installKiroStandaloneHooks(ORCA_HOOK.action.command)).toMatchObject({
      state: 'error',
      managedHooksPresent: false
    })
    expect(readFileSync(hooksFilePath(), 'utf-8')).toBe('{ "version": "v1", "hooks": ')
  })

  it.each([
    ['an empty object', {}, 'no hooks list'],
    ['a non-array hooks value', { version: 'v1', hooks: { Stop: [ORCA_HOOK] } }, 'no hooks list'],
    ['an empty hooks list', { version: 'v1', hooks: [] }, 'no hooks list'],
    [
      'a field Orca does not write',
      { version: 'v1', hooks: [ORCA_HOOK], description: 'mine' },
      'description'
    ],
    ['a non-v1 version', { version: 'v2', hooks: [ORCA_HOOK] }, 'not a version "v1"'],
    ['a hook Orca did not write', { version: 'v1', hooks: [ORCA_HOOK, USER_HOOK] }, 'Orca did not']
  ])('refuses to overwrite a same-named file with %s', (_label, content, reason) => {
    const userFile = JSON.stringify(content)
    writeHooksFile(userFile)

    const status = installKiroStandaloneHooks(ORCA_HOOK.action.command)
    expect(status).toMatchObject({ state: 'error', detail: expect.stringContaining(reason) })
    expect(readFileSync(hooksFilePath(), 'utf-8')).toBe(userFile)
  })

  it('strips only its own hooks from a file that mixes in hooks someone else added', () => {
    installKiroStandaloneHooks(ORCA_HOOK.action.command)
    const file = readHooksFile()
    writeHooksFile(JSON.stringify({ ...file, hooks: [...(file.hooks ?? []), USER_HOOK] }))

    const status = removeKiroStandaloneHooks()
    expect(readHooksFile()).toEqual({ version: 'v1', hooks: [USER_HOOK] })
    expect(status).toMatchObject({ managedHooksPresent: false })
  })

  it('leaves a same-named file alone on remove when it does not run the Orca script', () => {
    const userFile = JSON.stringify({ version: 'v1', hooks: [USER_HOOK] })
    writeHooksFile(userFile)
    removeKiroStandaloneHooks()
    expect(readFileSync(hooksFilePath(), 'utf-8')).toBe(userFile)
  })
})

describe('KiroHookService with the V3 standalone hooks file', () => {
  const defaultKiroHome = (): string => join(home, '.kiro')

  it('removes both the agent-config hooks and its own V3 file', () => {
    writeAgent(defaultKiroHome(), 'plain')
    const service = new KiroHookService()
    expect(service.install().state).toBe('installed')

    expect(service.remove().state).toBe('not_installed')
    expect(existsSync(hooksFilePath())).toBe(false)
    expect(JSON.parse(readFileSync(agentPath(defaultKiroHome(), 'plain'), 'utf-8'))).toEqual({
      name: 'plain'
    })
  })

  it('downgrades installed to partial and names the V3 file it could not write', () => {
    writeAgent(defaultKiroHome(), 'plain')
    writeHooksFile(JSON.stringify({ version: 'v1', hooks: [USER_HOOK] }))

    const status = new KiroHookService().install()
    expect(status).toMatchObject({
      state: 'partial',
      managedHooksPresent: true,
      detail: expect.stringContaining(hooksFilePath())
    })
    expect(status.detail).toContain('Orca did not write')
  })

  it('keeps the agent-config state when no custom agent exists and appends the V3 error', () => {
    writeHooksFile('{}')

    const status = new KiroHookService().install()
    expect(status.state).toBe('not_installed')
    expect(status.detail).toContain('kiro-cli agent create')
    expect(status.detail).toContain(hooksFilePath())
  })

  it('surfaces only V3 errors, not a V3 file that merely lost a trigger', () => {
    writeAgent(defaultKiroHome(), 'plain')
    const service = new KiroHookService()
    service.install()
    const file = readHooksFile()
    writeHooksFile(
      JSON.stringify({ ...file, hooks: file.hooks?.filter((entry) => entry.trigger !== 'Stop') })
    )
    expect(service.getStatus()).toMatchObject({ state: 'installed', detail: null })
  })

  it('downgrades a remote install that patched every agent when the V3 file is foreign', async () => {
    writeAgent(defaultKiroHome(), 'remote')
    writeHooksFile(JSON.stringify({ version: 'v1', hooks: [USER_HOOK] }))

    const status = await new KiroHookService().installRemote(
      createManagedHookLocalFilesystem(),
      home
    )
    expect(status).toMatchObject({
      state: 'partial',
      detail: expect.stringContaining('Orca did not')
    })
    expect(readHooksFile()).toEqual({ version: 'v1', hooks: [USER_HOOK] })
  })
})
