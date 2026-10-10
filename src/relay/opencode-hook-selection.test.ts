import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import { RelayAgentHookRuntime } from './relay-agent-hook-runtime'
import type { RelayDispatcher } from '../wsl-guest/dispatcher'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../shared/agent-hook-relay'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: async () => null
}))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../wsl-guest/agent-hook-server', () => ({
  RelayAgentHookServer: class {
    start = async () => {}
    stop = () => {}
    buildPtyEnv = () => ({ ORCA_AGENT_HOOK_PORT: '12345' })
    clearPaneState = () => {}
  }
}))
let root: string
let harness: ReturnType<typeof beginPtyHandlerTest>
let runtime: RelayAgentHookRuntime
let custom: string
const plugin = (dir: string, agent: string) => join(dir, 'plugins', `orca-${agent}-status.js`)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-relay-disabled-'))
  custom = join(root, 'custom')
  mkdirSync(custom)
  writeFileSync(join(custom, 'opencode.json'), '{"model":"fixture"}')
  vi.stubEnv('HOME', root)
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
  for (const key of [
    'OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    'ORCA_OPENCODE_AGENT',
    'ZDOTDIR'
  ]) {
    vi.stubEnv(key, undefined)
  }
  harness = beginPtyHandlerTest(mocks)
  runtime = new RelayAgentHookRuntime(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this harness implements the request registration used by the runtime; PTY and disk paths are real.
    harness.dispatcher as unknown as RelayDispatcher,
    harness.handler,
    join(root, 'relay.sock')
  )
  await runtime.start()
})
afterEach(async () => {
  runtime.stop()
  await endPtyHandlerTest(harness.handler, harness.originalPlatform)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
async function install(v1: string, v2: string): Promise<void> {
  await harness.dispatcher.callRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, {
    opencodePluginSource: v1,
    opencode2PluginSource: v2
  })
}
async function spawn(params: Record<string, unknown> = {}): Promise<Record<string, string>> {
  await harness.dispatcher.callRequest('pty.spawn', {
    cwd: root,
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    command: 'echo fixture',
    ...params
  })
  return mocks.mockPtySpawn.mock.calls.at(-1)?.[2].env
}

describe('relay OpenCode source selection on real fixture files', () => {
  it.each(['home', 'xdg', 'shell'] as const)(
    'consumer config root follows the remote %s environment',
    async (kind) => {
      await install('// remote plugin', '')
      const home = join(root, 'remote-home')
      const xdg = join(root, 'remote-xdg')
      const consumer = kind === 'home' ? join(home, '.config', 'opencode') : join(xdg, 'opencode')
      mkdirSync(home, { recursive: true })
      mkdirSync(consumer, { recursive: true })
      writeFileSync(join(consumer, 'opencode.json'), '{"model":"remote-model"}')
      if (kind === 'shell') {
        writeFileSync(join(home, '.zshrc'), `export XDG_CONFIG_HOME='${xdg}'\n`)
      }
      const env = await spawn({
        cwd: home,
        launchAgent: 'opencode',
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: kind === 'xdg' ? xdg : '',
          SHELL: kind === 'shell' ? '/bin/zsh' : '/bin/sh'
        }
      })
      expect(readFileSync(plugin(consumer, 'opencode'), 'utf8')).toBe('// remote plugin')
      expect(existsSync(plugin(join(root, 'xdg', 'opencode'), 'opencode'))).toBe(false)
      expect(readFileSync(join(consumer, 'opencode.json'), 'utf8')).toBe('{"model":"remote-model"}')
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.HOME).toBe(home)
      expect(env.XDG_CONFIG_HOME).toBe(kind === 'xdg' ? xdg : '')
    }
  )

  it('leaves a standalone relay without supplied sources unconfigured', async () => {
    const env = await spawn()
    expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
    expect(existsSync(join(root, 'xdg', 'opencode'))).toBe(false)
  })
  it.each([
    { v1: '// v1', v2: '// v2', selected: 'opencode' },
    { v1: '', v2: '// v2', selected: 'opencode2' },
    { v1: '// v1', v2: '', selected: 'opencode' },
    { v1: '', v2: '', selected: undefined }
  ])('ordinary terminal with sources $v1 / $v2', async ({ v1, v2, selected }) => {
    await install(v1, v2)
    const env = await spawn()
    expect(env.ORCA_OPENCODE_AGENT).toBe(selected)
    for (const agent of ['opencode', 'opencode2']) {
      expect(existsSync(plugin(join(root, 'xdg', 'opencode'), agent))).toBe(agent === selected)
    }
  })
  it.each(['opencode', 'opencode2'] as const)(
    'does not substitute another plugin for disabled explicit %s',
    async (agent) => {
      await install(agent === 'opencode' ? '' : '// v1', agent === 'opencode2' ? '' : '// v2')
      for (const params of [{ command: `${agent} --session fixture` }, { launchAgent: agent }]) {
        const env = await spawn(params)
        expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
        expect(existsSync(join(root, 'xdg', 'opencode'))).toBe(false)
      }
    }
  )
  it('updates cached sources on one runtime and leaves old plugin files intact', async () => {
    await install('// v1', '// v2')
    await spawn()
    const original = plugin(join(root, 'xdg', 'opencode'), 'opencode')
    writeFileSync(original, '// sentinel')
    await install('', '// v2')
    expect((await spawn()).ORCA_OPENCODE_AGENT).toBe('opencode2')
    expect(readFileSync(original, 'utf8')).toBe('// sentinel')
    await install('// refreshed v1', '// v2')
    expect((await spawn()).ORCA_OPENCODE_AGENT).toBe('opencode')
    expect(readFileSync(original, 'utf8')).toBe('// refreshed v1')
  })
  // Why: a running OpenCode 2 service reloads a changed plugin file, so connecting must upgrade it.
  it('refreshes an existing canonical plugin on install without creating a new one', async () => {
    const dir = join(root, 'xdg', 'opencode')
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    writeFileSync(plugin(dir, 'opencode2'), '// old v2')
    await install('// v1', '// v2')
    expect(readFileSync(plugin(dir, 'opencode2'), 'utf8')).toBe('// v2')
    const tuiEntry = join(dir, 'plugins', 'orca-opencode2-status-tui', 'tui.js')
    expect(readFileSync(tuiEntry, 'utf8')).toBe('// v2')
    expect(existsSync(plugin(dir, 'opencode'))).toBe(false)
  })
  it('restores the real custom source when all OpenCode sources are revoked', async () => {
    await install('// v1', '// v2')
    const first = await spawn({ env: { OPENCODE_CONFIG_DIR: custom } })
    const path = plugin(first.OPENCODE_CONFIG_DIR, 'opencode')
    expect(readFileSync(path, 'utf8')).toBe('// v1')
    await install('', '')
    const env = await spawn({ env: first })
    expect(env.OPENCODE_CONFIG_DIR).toBe(custom)
    expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('// v1')
    expect(env.ORCA_AGENT_HOOK_PORT).toBe('12345')
  })
})

it.each([true, false])(
  'preserves explicit config over inherited relay markers with hooks %s',
  async (enabled) => {
    await install(enabled ? '// v1' : '', '')
    const stale = join(root, 'stale-source')
    mkdirSync(stale)
    writeFileSync(join(stale, 'opencode.json'), '{"model":"stale"}')
    vi.stubEnv('ORCA_OPENCODE_CONFIG_DIR', join(root, 'old-overlay'))
    vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', stale)
    const env = await spawn({ env: { OPENCODE_CONFIG_DIR: custom } })
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
      '{"model":"fixture"}'
    )
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(enabled ? custom : undefined)
    expect(existsSync(plugin(stale, 'opencode'))).toBe(false)
  }
)

it.each([true, false])(
  'restores legacy source-only overlay markers with hooks %s',
  async (enabled) => {
    await install('// v1', '')
    const parent = await spawn({ env: { OPENCODE_CONFIG_DIR: custom } })
    delete parent.ORCA_OPENCODE_CONFIG_DIR
    if (!enabled) {
      await install('', '')
    }
    const env = await spawn({ env: parent })
    expect(env.OPENCODE_CONFIG_DIR).toEqual(enabled ? expect.any(String) : custom)
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
      '{"model":"fixture"}'
    )
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(enabled ? custom : undefined)
  }
)
