import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KiroHookService } from './hook-service'
import { getKiroManagedCommandMatcher, getKiroStandaloneManagedCommand } from './hook-settings'
import { KIRO_STANDALONE_HOOK_TRIGGERS } from './standalone-hook-settings'
import { installKiroStandaloneHooks, removeKiroStandaloneHooks } from './standalone-hooks'

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows; set both to isolate real homes.
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
  const defaultKiroHome = (): string => join(home, '.kiro')

  it('covers the built-in default agent on V3 even with no custom agent', () => {
    expect(new KiroHookService().install()).toMatchObject({
      state: 'partial',
      managedHooksPresent: true
    })
    const file = readHooksFile()
    expect(file.version).toBe('v1')
    expect(file.hooks?.map((entry) => entry.trigger)).toEqual([...KIRO_STANDALONE_HOOK_TRIGGERS])
    const isManaged = getKiroManagedCommandMatcher()
    for (const entry of file.hooks ?? []) {
      expect(isManaged(entry.action.command)).toBe(true)
    }
  })

  it('follows KIRO_HOME, which V3 reads global hooks from since kiro-cli 2.31', () => {
    const kiroHome = join(home, 'custom-kiro')
    writeAgent(kiroHome, 'relocated')
    process.env.KIRO_HOME = kiroHome

    expect(new KiroHookService().install().state).toBe('installed')
    expect(existsSync(join(kiroHome, 'hooks', 'orca-agent-status.json'))).toBe(true)
    expect(existsSync(hooksFilePath())).toBe(false)
  })

  it.each([
    ['unparsable JSON', '{ "version": "v1", "hooks": '],
    ['a hook Orca did not write', JSON.stringify({ version: 'v1', hooks: [ORCA_HOOK, USER_HOOK] })]
  ])('leaves a same-named file with %s untouched and reports it', (_label, userFile) => {
    writeAgent(defaultKiroHome(), 'plain')
    writeHooksFile(userFile)

    const status = new KiroHookService().install()
    expect(status).toMatchObject({
      state: 'partial',
      detail: expect.stringContaining(hooksFilePath())
    })
    expect(readFileSync(hooksFilePath(), 'utf-8')).toBe(userFile)
  })

  it('strips only its own hooks from a file that mixes in hooks someone else added', () => {
    installKiroStandaloneHooks(ORCA_HOOK.action.command)
    const file = readHooksFile()
    writeHooksFile(JSON.stringify({ ...file, hooks: [...(file.hooks ?? []), USER_HOOK] }))

    removeKiroStandaloneHooks()
    expect(readHooksFile()).toEqual({ version: 'v1', hooks: [USER_HOOK] })
  })

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
})

describe('Kiro V3 standalone hook command', () => {
  const payload = '{"hook_event_name":"PreToolUse","tool_name":"shell"}'

  // A file as stdin shares its offset with the child, so the bytes left over are what nothing read.
  function runHook(
    command: string,
    env: NodeJS.ProcessEnv
  ): { status: number | null; unread: string } {
    const payloadPath = join(home, 'payload.json')
    writeFileSync(payloadPath, payload)
    const fd = openSync(payloadPath, 'r')
    try {
      const { status } = spawnSync('/bin/sh', ['-c', command], { stdio: [fd, 'pipe', 'pipe'], env })
      const rest = Buffer.alloc(payload.length)
      return {
        status,
        unread: rest.subarray(0, readSync(fd, rest, 0, rest.length, null)).toString()
      }
    } finally {
      closeSync(fd)
    }
  }

  it.skipIf(process.platform === 'win32')(
    'exits in the host shell outside an Orca pane, and runs the script inside one',
    () => {
      new KiroHookService().install()
      const command = readHooksFile().hooks?.[0]?.action.command ?? ''
      const env = { PATH: process.env.PATH, HOME: home }

      expect(runHook(command, env)).toEqual({ status: 0, unread: payload })
      expect(runHook(command, { ...env, ORCA_PANE_KEY: 'tab-1:pane-1' })).toEqual({
        status: 0,
        unread: ''
      })
    }
  )

  it('starts no PowerShell outside an Orca pane for a path cmd.exe cannot run directly', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(
        getKiroStandaloneManagedCommand('C:\\Users\\Dev Name\\.orca\\agent-hooks\\kiro-hook.cmd')
      ).toMatch(/^if defined ORCA_PANE_KEY \S+\/powershell\.exe -NoProfile -EncodedCommand /)
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }
  })
})
