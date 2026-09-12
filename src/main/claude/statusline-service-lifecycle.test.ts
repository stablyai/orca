import type * as os from 'node:os'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => home.path
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync)
  }
})
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic/unused' } }))
vi.mock('../codex/managed-home-shell-preflight', () => ({
  prepareManagedCodexHomeBeforeShellLaunch: vi.fn()
}))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: () => Promise.resolve({ claude: { state: 'missing' } })
}))
vi.mock('../agent-hooks/managed-agent-hook-registry', async () => {
  const { claudeHookService } = await import('./hook-service')
  return {
    MANAGED_AGENT_HOOK_INSTALLERS: [['claude', () => claudeHookService.install()]],
    MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS: [
      ['claude', () => claudeHookService.refreshManagedScripts()]
    ],
    MANAGED_AGENT_HOOK_REMOVERS: [],
    MANAGED_AGENT_HOOK_ASYNC_REMOVERS: [],
    MANAGED_AGENT_HOOK_STATUS_READERS: []
  }
})
vi.mock('../git-bash', () => ({ isGitBashAvailable: () => true }))
import { installManagedAgentHooks } from '../agent-hooks/managed-agent-hook-controls'
import { getManagedStatusLineScript } from './statusline-script'
import { ClaudeHookService } from './hook-service'
import {
  OPENCLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptPath,
  getManagedCommand
} from './hook-settings'
import { readStatusLineInstallMarker, statusLineCommandSha256 } from './statusline-install-marker'
import runtimeFixtures from './statusline-command-fixtures.json'
import legacyFixtures from './statusline-legacy-fixtures.json'

const service = new ClaudeHookService()
const read = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))
const seed = (statusLine?: unknown) => {
  fs.mkdirSync(join(home.path, '.claude'), { recursive: true })
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      unrelated: { keep: true },
      ...(statusLine === undefined ? {} : { statusLine })
    })
  )
}
const marker = (content = '') => {
  fs.mkdirSync(join(home.path, '.orca', 'agent-hooks'), { recursive: true })
  fs.writeFileSync(getStatusLineInstallMarkerPath(), content)
}
const current = () => ({ type: 'command', command: getManagedCommand(getStatusLineScriptPath()) })
const error = () => Object.assign(new Error('synthetic denied'), { code: 'EACCES' })

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  for (const name of ['openSync', 'readSync', 'writeFileSync', 'renameSync', 'rmSync'] as const) {
    vi.mocked(fs[name]).mockImplementation(actual[name] as never)
  }
  home.path = fs.mkdtempSync(join(tmpdir(), 'orca-statusline-owner-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home.path, { recursive: true, force: true })
})

describe('actual service with synthetic real settings and marker files', () => {
  it('publishes settings before fingerprint, backs up, respects deletion, and re-enables after removal', () => {
    seed()
    const original = fs.readFileSync(getConfigPath(), 'utf8')
    service.install()
    expect(read()).toMatchObject({ unrelated: { keep: true }, statusLine: current() })
    expect(fs.readFileSync(`${getConfigPath()}.bak`, 'utf8')).toBe(original)
    expect(readStatusLineInstallMarker(getStatusLineInstallMarkerPath())).toEqual({
      present: true,
      commandSha256: statusLineCommandSha256(current().command)
    })
    seed()
    service.install()
    expect(read().statusLine).toBeUndefined()
    service.remove()
    service.install()
    expect(read().statusLine).toEqual(current())
  })

  it.each([...runtimeFixtures, ...legacyFixtures])(
    'migrates actual producer $sha256 and resets opt-out',
    ({ command }) => {
      seed({ type: 'command', command })
      marker()
      service.install()
      expect(read().statusLine).toEqual(current())
      service.remove()
      expect(read().statusLine).toBeUndefined()
      expect(fs.existsSync(getStatusLineInstallMarkerPath())).toBe(false)
      service.install()
      expect(read().statusLine).toEqual(current())
    }
  )

  it.each([false, true])('preserves composites and metadata with marker=%s', (installed) => {
    for (const statusLine of [
      null,
      '',
      { type: 'custom' },
      { ...current(), command: `${current().command}; printf user` },
      { ...current(), padding: 2 },
      { type: 'command', command: "echo 'agent-hooks/claude-statusline.ps1'" }
    ]) {
      seed(statusLine)
      if (installed) {
        marker()
      }
      service.install()
      expect(read().statusLine).toEqual(statusLine)
      service.remove()
      expect(read()).toMatchObject({ statusLine, unrelated: { keep: true } })
    }
  })

  it('upgrades retired output only with matching fingerprint, tolerates zero-byte downgrade', () => {
    const command = 'retired producer bytes'
    seed({ type: 'command', command })
    marker(JSON.stringify({ version: 1, commandSha256: statusLineCommandSha256(command) }))
    service.install()
    expect(read().statusLine).toEqual(current())
    marker()
    service.install()
    expect(read().statusLine).toEqual(current())
    seed({ type: 'command', command: `${command} changed` })
    marker(JSON.stringify({ version: 1, commandSha256: statusLineCommandSha256(command) }))
    service.install()
    service.remove()
    expect(read().statusLine.command).toBe(`${command} changed`)
  })

  it.each(['', 'invalid', '{"version":2}', 'x'.repeat(1025)])(
    'uncertain/existing marker protects absence (%s)',
    (content) => {
      seed()
      marker(content)
      service.install()
      expect(read().statusLine).toBeUndefined()
      seed(current())
      service.install()
      expect(read().statusLine).toEqual(current())
    }
  )

  it('settings rename failure retains the old marker for install and remove', async () => {
    seed(current())
    marker('old-marker')
    const actual = await vi.importActual<typeof fs>('node:fs')
    const denied = vi.fn()
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (to === getConfigPath()) {
        denied()
        throw error()
      }
      return actual.renameSync(from, to)
    })
    expect(() => service.install()).toThrow()
    expect(fs.readFileSync(getStatusLineInstallMarkerPath(), 'utf8')).toBe('old-marker')
    expect(() => service.remove()).toThrow()
    expect(denied).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(getStatusLineInstallMarkerPath(), 'utf8')).toBe('old-marker')
  })

  it('marker write failure leaves settings successful and retries metadata later', async () => {
    seed()
    const actual = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fs.writeFileSync).mockImplementation((path, ...args) => {
      if (path === getStatusLineInstallMarkerPath()) {
        expect(read().statusLine).toEqual(current())
        throw error()
      }
      return actual.writeFileSync(path, ...args)
    })
    service.install()
    expect(read().statusLine).toEqual(current())
    expect(fs.existsSync(getStatusLineInstallMarkerPath())).toBe(false)
    vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
    service.install()
    expect(readStatusLineInstallMarker(getStatusLineInstallMarkerPath()).commandSha256).toBeTruthy()
  })

  it('marker removal failure keeps conservative opt-out', async () => {
    seed()
    service.install()
    const actual = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      if (path === getStatusLineInstallMarkerPath()) {
        throw error()
      }
      return actual.rmSync(path, options)
    })
    service.remove()
    service.install()
    expect(read().statusLine).toBeUndefined()
  })

  it('unreadable marker blocks empty install but not exact generated migration', async () => {
    seed()
    marker()
    const actual = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fs.openSync).mockImplementation((path, ...args) => {
      if (path === getStatusLineInstallMarkerPath()) {
        throw error()
      }
      return actual.openSync(path, ...args)
    })
    service.install()
    expect(read().statusLine).toBeUndefined()
    seed(current())
    service.install()
    expect(read().statusLine).toEqual(current())
  })

  it('refuses malformed settings without publishing marker', () => {
    seed()
    fs.writeFileSync(getConfigPath(), '{broken')
    expect(service.install().state).toBe('error')
    expect(service.remove().state).toBe('error')
    expect(fs.existsSync(getStatusLineInstallMarkerPath())).toBe(false)
    expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe('{broken')
  })
})

it.each([false, true])(
  'startup controls refresh only present reporter: present=%s',
  async (present) => {
    const statusLine = { ...current(), command: `${current().command}; printf user`, padding: 1 }
    seed(statusLine)
    const original = fs.readFileSync(getConfigPath(), 'utf8')
    if (present) {
      marker()
      fs.writeFileSync(getStatusLineScriptPath(), 'old reporter')
    }
    const result = await installManagedAgentHooks({}, { agents: ['claude'] })
    expect(result[0].skipReason).toBe('cli_not_found')
    expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(original)
    expect(fs.existsSync(getStatusLineScriptPath())).toBe(present)
    if (present) {
      expect(fs.readFileSync(getStatusLineScriptPath(), 'utf8')).toBe(
        getManagedStatusLineScript('local')
      )
    }
  }
)

it.each(['linux', 'win32'] as const)(
  'actual service preserves composites and broad hook cleanup on simulated %s',
  (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      const statusLine = { ...current(), command: `${current().command}; printf user` }
      seed(statusLine)
      const userHook = { type: 'command', command: 'printf keep' }
      const hooks = [
        {
          hooks: [
            userHook,
            ...['sh', 'cmd', 'ps1'].map((ext) => ({
              type: 'command',
              command: `echo agent-hooks/claude-hook.${ext}`
            }))
          ]
        }
      ]
      fs.writeFileSync(
        getConfigPath(),
        JSON.stringify({ statusLine, unrelated: 1, hooks: { Stop: hooks } })
      )
      service.install()
      expect(read().statusLine).toEqual(statusLine)
      expect(fs.existsSync(getStatusLineInstallMarkerPath())).toBe(false)
      expect(fs.existsSync(getStatusLineScriptPath())).toBe(false)
      service.remove()
      expect(read()).toEqual({ statusLine, unrelated: 1, hooks: { Stop: [{ hooks: [userHook] }] } })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }
)

it('OpenClaude install/remove does not create a statusLine or reporter', () => {
  const other = new ClaudeHookService({
    agent: 'openclaude',
    displayName: 'OpenClaude',
    settings: OPENCLAUDE_HOOK_SETTINGS
  })
  other.install()
  const path = getConfigPath(OPENCLAUDE_HOOK_SETTINGS)
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).statusLine).toBeUndefined()
  expect(fs.existsSync(getStatusLineScriptPath(OPENCLAUDE_HOOK_SETTINGS))).toBe(false)
  other.remove()
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).statusLine).toBeUndefined()
})
