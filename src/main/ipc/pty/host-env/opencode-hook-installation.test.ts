import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDaemonPtyEnvironment,
  rescrubDaemonPtyEnvironment
} from '../../../daemon/pty-subprocess/spawn-environment'
import { getInheritedAgentHookEnvKeysToDelete } from './pi-agent'
import { buildPtyHostEnv } from './assembly'
import { wslHookRelayManager } from '../../../agent-hooks/wsl-hook-relay-manager'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => {
  const guestAgentPaths: Record<string, string> = {}
  return { userData: '', guestOverlay: '', guestAgentPaths }
})
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => fixture.guestOverlay,
    // Why: kind-keyed so a WSL Pi/OMP/OmO launch can be told apart by the env it receives.
    getGuestAgentPath: (_distro: string | null, kind: string) =>
      fixture.guestAgentPaths[kind] ?? null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))

let root: string
let config: string
let custom: string
let options: BuildPtyHostEnvOptions
const plugin = (dir: string, agent: string) => join(dir, 'plugins', `orca-${agent}-status.js`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-opencode-disabled-'))
  const home = join(root, 'home')
  const xdg = join(root, 'xdg')
  mkdirSync(home)
  fixture.userData = join(root, 'user-data')
  fixture.guestOverlay = join(root, 'guest-overlay')
  fixture.guestAgentPaths = {
    pi: join(root, 'guest-pi-agent'),
    omp: join(root, 'guest-omp-status.ts'),
    omo: join(root, 'guest-omo-agent')
  }
  config = join(xdg, 'opencode')
  custom = join(root, 'custom')
  mkdirSync(join(custom, 'plugins'), { recursive: true })
  writeFileSync(join(custom, 'opencode.json'), '{"model":"fixture"}')
  writeFileSync(join(custom, 'plugins', 'user.js'), '// user plugin')
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('XDG_CONFIG_HOME', xdg)
  for (const key of [
    'OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
    'ORCA_OPENCODE_AGENT',
    'ZDOTDIR'
  ]) {
    vi.stubEnv(key, undefined)
  }
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('OpenCode installation uses the current enabled agents', () => {
  const combinations = [
    { disabled: [], fallback: 'opencode' },
    { disabled: ['opencode'], fallback: 'opencode2' },
    { disabled: ['opencode2'], fallback: 'opencode' },
    { disabled: ['opencode', 'opencode2'], fallback: undefined }
  ]
  for (const { disabled, fallback } of combinations) {
    it.each(['default', 'custom'])(`bare %s config with disabled ${disabled.join(',')}`, (kind) => {
      const env = buildPtyHostEnv(
        'pane',
        kind === 'custom' ? { OPENCODE_CONFIG_DIR: custom } : {},
        {
          ...options,
          disabledTuiAgents: disabled
        }
      )
      expect(env.ORCA_OPENCODE_AGENT).toBe(fallback)
      const selected = env.OPENCODE_CONFIG_DIR ?? config
      for (const agent of ['opencode', 'opencode2']) {
        expect(existsSync(plugin(selected, agent))).toBe(agent === fallback)
      }
      if (kind === 'custom') {
        expect(readFileSync(join(selected, 'plugins', 'user.js'), 'utf8')).toBe('// user plugin')
        expect(readFileSync(join(selected, 'opencode.json'), 'utf8')).toBe('{"model":"fixture"}')
        expect(existsSync(plugin(custom, 'opencode'))).toBe(false)
      }
    })
    it.each(['opencode', 'opencode2'] as const)(
      `explicit %s with disabled ${disabled.join(',')}`,
      (agent) => {
        for (const selection of [
          { launchCommand: `${agent} --session fixture` },
          { launchAgent: agent }
        ]) {
          const env = buildPtyHostEnv(
            'pane',
            {},
            { ...options, ...selection, disabledTuiAgents: disabled }
          )
          const selected = disabled.includes(agent) ? undefined : agent
          expect(env.ORCA_OPENCODE_AGENT).toBe(selected)
          expect(existsSync(plugin(config, agent))).toBe(selected === agent)
          expect(existsSync(plugin(config, agent === 'opencode' ? 'opencode2' : 'opencode'))).toBe(
            false
          )
        }
      }
    )
  }

  it('reads enable/disable changes on the same services without deleting installed files', () => {
    buildPtyHostEnv('first', {}, options)
    const installed = plugin(config, 'opencode')
    writeFileSync(installed, '// already installed sentinel')
    const env = buildPtyHostEnv('second', {}, { ...options, disabledTuiAgents: ['opencode'] })
    expect(env.ORCA_OPENCODE_AGENT).toBe('opencode2')
    expect(readFileSync(installed, 'utf8')).toBe('// already installed sentinel')
    buildPtyHostEnv('third', {}, options)
    expect(readFileSync(installed, 'utf8')).toContain('/hook/opencode')
  })

  it.each([true, false])(
    'restores inherited source and clears markers with hooks %s',
    (enabled) => {
      const first = buildPtyHostEnv('first', { OPENCODE_CONFIG_DIR: custom }, options)
      const original = readFileSync(plugin(first.OPENCODE_CONFIG_DIR, 'opencode'), 'utf8')
      const env = buildPtyHostEnv(
        'second',
        { ...first },
        {
          ...options,
          agentStatusHooksEnabled: enabled,
          disabledTuiAgents: ['opencode', 'opencode2']
        }
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe(custom)
      expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
      expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
      expect(readFileSync(plugin(first.OPENCODE_CONFIG_DIR, 'opencode'), 'utf8')).toBe(original)
      expect(env.ORCA_AGENT_HOOK_PORT).toBe(enabled ? '12345' : undefined)
    }
  )

  it('drops an inherited overlay without a source and preserves an unrelated explicit config', () => {
    for (const primary of [fixture.guestOverlay, custom]) {
      const env = buildPtyHostEnv(
        'pane',
        {
          OPENCODE_CONFIG_DIR: primary,
          ORCA_OPENCODE_CONFIG_DIR: fixture.guestOverlay,
          ORCA_OPENCODE_AGENT: 'opencode'
        },
        { ...options, disabledTuiAgents: ['opencode', 'opencode2'] }
      )
      expect(env.OPENCODE_CONFIG_DIR).toBe(primary === custom ? custom : undefined)
      expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
    }
  })

  it('hands each WSL Pi, OMP, and OmO launch its own guest agent path', () => {
    const pi = buildPtyHostEnv('wsl-pi', {}, { ...options, isWsl: true, launchCommand: 'pi' })
    expect(pi.ORCA_PI_SOURCE_AGENT_DIR).toBe(fixture.guestAgentPaths.pi)
    expect(pi.ORCA_OMP_STATUS_EXTENSION).toBeUndefined()
    expect(pi.ORCA_OMO_SOURCE_AGENT_DIR).toBeUndefined()

    const omp = buildPtyHostEnv('wsl-omp', {}, { ...options, isWsl: true, launchCommand: 'omp' })
    expect(omp.ORCA_OMP_STATUS_EXTENSION).toBe(fixture.guestAgentPaths.omp)
    expect(omp.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    expect(omp.ORCA_OMO_SOURCE_AGENT_DIR).toBeUndefined()

    const omo = buildPtyHostEnv('wsl-omo', {}, { ...options, isWsl: true, launchCommand: 'omo' })
    // Why: OmO installs into its real agent dir, so the guest dir is the source dir.
    expect(omo.ORCA_OMO_SOURCE_AGENT_DIR).toBe(fixture.guestAgentPaths.omo)
    expect(omo.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    expect(omo.ORCA_OMP_STATUS_EXTENSION).toBeUndefined()

    expect(vi.mocked(wslHookRelayManager.ensureForDistro).mock.calls).toEqual([
      [null, null, 'pi'],
      [null, null, 'omp'],
      [null, null, 'omo']
    ])
  })

  it('does not write a native plugin for WSL or inject a disabled guest overlay', () => {
    const enabled = buildPtyHostEnv(
      'wsl-enabled',
      {},
      { ...options, isWsl: true, launchAgent: 'opencode2' }
    )
    expect(enabled.OPENCODE_CONFIG_DIR).toBe(fixture.guestOverlay)
    expect(existsSync(config)).toBe(false)
    const disabled = buildPtyHostEnv(
      'wsl-disabled',
      {},
      {
        ...options,
        isWsl: true,
        disabledTuiAgents: ['opencode', 'opencode2']
      }
    )
    expect(disabled.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(disabled.ORCA_AGENT_HOOK_ENDPOINT).toBe('/guest/endpoint.json')
    expect(existsSync(config)).toBe(false)
  })
})

it.each(['source', 'no-source', 'user-config'])(
  'carries sparse host cleanup into daemon %s env',
  (kind) => {
    const prepared = buildPtyHostEnv(
      'daemon-pane',
      {},
      {
        ...options,
        disabledTuiAgents: ['opencode', 'opencode2']
      }
    )
    vi.stubEnv('OPENCODE_CONFIG_DIR', kind === 'user-config' ? custom : fixture.guestOverlay)
    vi.stubEnv('ORCA_OPENCODE_CONFIG_DIR', fixture.guestOverlay)
    vi.stubEnv('ORCA_OPENCODE_AGENT', 'opencode')
    if (kind === 'source') {
      vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', custom)
    }
    const result = createDaemonPtyEnvironment({
      sessionId: 'fixture',
      cols: 80,
      rows: 24,
      env: prepared,
      envToDelete: getInheritedAgentHookEnvKeysToDelete(prepared)
    })
    expect(result.OPENCODE_CONFIG_DIR).toBe(kind === 'no-source' ? undefined : custom)
    expect(result.ORCA_OPENCODE_AGENT).toBeUndefined()
    expect(result.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(result.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
  }
)

it.each([
  { primary: 'overlay', source: true, explicit: true, expected: 'current' },
  { primary: 'current', source: true, explicit: false, expected: 'current' },
  { primary: 'overlay', source: true, explicit: false, expected: 'previous' },
  { primary: 'absent', source: true, explicit: false, expected: 'previous' },
  { primary: 'overlay', source: false, explicit: false, expected: undefined },
  { primary: 'overlay', source: false, explicit: true, expected: 'current' },
  { primary: 'absent', source: false, explicit: false, expected: undefined }
])('daemon config precedence: $primary, source $source, explicit $explicit', (scenario) => {
  const prepared = buildPtyHostEnv(
    'daemon-pane',
    scenario.explicit ? { OPENCODE_CONFIG_DIR: custom } : {},
    { ...options, disabledTuiAgents: ['opencode', 'opencode2'] }
  )
  const previous = join(root, 'previous')
  mkdirSync(previous)
  writeFileSync(join(previous, 'opencode.json'), '{"model":"previous"}')
  vi.stubEnv(
    'OPENCODE_CONFIG_DIR',
    scenario.primary === 'absent'
      ? undefined
      : scenario.primary === 'current'
        ? custom
        : fixture.guestOverlay
  )
  vi.stubEnv('ORCA_OPENCODE_CONFIG_DIR', fixture.guestOverlay)
  vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', scenario.source ? previous : undefined)
  vi.stubEnv('ORCA_OPENCODE_AGENT', 'opencode')
  const request = {
    sessionId: 'fixture',
    cols: 80,
    rows: 24,
    env: prepared,
    envToDelete: getInheritedAgentHookEnvKeysToDelete(prepared)
  }
  const result = createDaemonPtyEnvironment(request)
  rescrubDaemonPtyEnvironment(result, request)
  if (scenario.expected) {
    expect(readFileSync(join(result.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
      scenario.expected === 'current' ? '{"model":"fixture"}' : '{"model":"previous"}'
    )
  } else {
    expect(result.OPENCODE_CONFIG_DIR).toBeUndefined()
  }
  expect(result.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
  expect(result.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
  expect(result.ORCA_OPENCODE_AGENT).toBeUndefined()
})

it.each(['opencode', 'opencode2'] as const)(
  'keeps the freshly selected %s overlay through a stale daemon',
  (agent) => {
    const prepared = buildPtyHostEnv(
      'pane',
      { OPENCODE_CONFIG_DIR: custom },
      {
        ...options,
        launchAgent: agent
      }
    )
    vi.stubEnv('OPENCODE_CONFIG_DIR', fixture.guestOverlay)
    vi.stubEnv('ORCA_OPENCODE_CONFIG_DIR', fixture.guestOverlay)
    vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', join(root, 'stale-source'))
    const result = createDaemonPtyEnvironment({
      sessionId: 'fixture',
      cols: 80,
      rows: 24,
      env: prepared,
      envToDelete: getInheritedAgentHookEnvKeysToDelete(prepared)
    })
    expect(readFileSync(join(result.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
      '{"model":"fixture"}'
    )
    expect(existsSync(plugin(result.OPENCODE_CONFIG_DIR, agent))).toBe(true)
    expect(result.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(custom)
    expect(result.ORCA_OPENCODE_AGENT).toBe(agent)
  }
)

it.each([true, false])(
  'preserves explicit host config over inherited markers with hooks %s',
  (enabled) => {
    const stale = join(root, 'stale-source')
    mkdirSync(stale)
    writeFileSync(join(stale, 'opencode.json'), '{"model":"stale"}')
    for (const inheritedFromProcess of [true, false]) {
      const markers = {
        ORCA_OPENCODE_CONFIG_DIR: join(root, 'old-overlay'),
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: stale
      }
      for (const [key, value] of Object.entries(markers)) {
        vi.stubEnv(key, inheritedFromProcess ? value : undefined)
      }
      const env = buildPtyHostEnv(
        'explicit-config',
        {
          ...(inheritedFromProcess ? {} : markers),
          OPENCODE_CONFIG_DIR: custom
        },
        { ...options, agentStatusHooksEnabled: enabled }
      )
      expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
        '{"model":"fixture"}'
      )
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(enabled ? custom : undefined)
      expect(existsSync(plugin(stale, 'opencode'))).toBe(false)
    }
  }
)

it.each([true, false])(
  'drops host config for disabled WSL variants with explicit primary %s',
  (explicit) => {
    const overlay = 'C:\\Users\\fixture\\Orca\\opencode-overlays\\old'
    const source = 'C:\\Users\\fixture\\config\\opencode'
    vi.stubEnv('ORCA_OPENCODE_CONFIG_DIR', overlay)
    vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', source)
    const env = buildPtyHostEnv(
      'wsl-disabled-inherited',
      {
        OPENCODE_CONFIG_DIR: explicit ? source : overlay,
        ORCA_OPENCODE_CONFIG_DIR: overlay,
        ORCA_OPENCODE_SOURCE_CONFIG_DIR: source
      },
      { ...options, isWsl: true, disabledTuiAgents: ['opencode', 'opencode2'] }
    )
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_AGENT).toBeUndefined()
    expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBe('/guest/endpoint.json')
    expect(existsSync(config)).toBe(false)
  }
)

// Why: pre-1.4.209 panes exported Orca's retired <userData>/opencode-hooks/shared dir. OpenCode 2
// treats OPENCODE_CONFIG_DIR as the only config dir, so inheriting it loaded a stale plugin and hid
// the user's global config.
describe.each([
  { name: 'marked', marked: true },
  { name: 'unmarked', marked: false }
])('inherited retired shared hooks dir ($name)', ({ marked }) => {
  it.each([
    { agent: 'opencode', hooksDir: 'opencode-hooks' },
    { agent: 'opencode', hooksDir: 'opencode2-hooks' },
    { agent: 'opencode2', hooksDir: 'opencode-hooks' },
    { agent: 'opencode2', hooksDir: 'opencode2-hooks' }
  ] as const)('drops $hooksDir for $agent panes', ({ agent, hooksDir }) => {
    const legacy = join(fixture.userData, hooksDir, 'shared')
    mkdirSync(join(legacy, 'plugins'), { recursive: true })
    const env = buildPtyHostEnv(
      'pane',
      marked
        ? { OPENCODE_CONFIG_DIR: legacy, ORCA_OPENCODE_CONFIG_DIR: legacy }
        : { OPENCODE_CONFIG_DIR: legacy },
      { ...options, launchAgent: agent }
    )
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    expect(existsSync(plugin(config, agent))).toBe(true)
    expect(existsSync(join(fixture.userData, `${agent}-config-overlays`))).toBe(false)
  })
})

it('keeps a user config dir that merely sits beside the retired hooks dir', () => {
  const neighbour = join(fixture.userData, 'opencode-hooks', 'mine')
  mkdirSync(neighbour, { recursive: true })
  const env = buildPtyHostEnv('pane', { OPENCODE_CONFIG_DIR: neighbour }, options)
  expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(neighbour)
  expect(env.OPENCODE_CONFIG_DIR).not.toBeUndefined()
})

it.each(['explicit', 'inherited'])('refreshes the %s stale plugin with hooks off', (source) => {
  const legacy = join(fixture.userData, 'opencode-hooks', 'shared')
  const stalePlugin = join(legacy, 'plugins', 'orca-opencode-status.js')
  mkdirSync(join(legacy, 'plugins'), { recursive: true })
  writeFileSync(stalePlugin, 'export default { id: "orca-opencode-status", server() {} }\n')
  if (source === 'inherited') {
    vi.stubEnv('OPENCODE_CONFIG_DIR', legacy)
  }
  const env = buildPtyHostEnv(
    'pane',
    source === 'explicit' ? { OPENCODE_CONFIG_DIR: legacy } : {},
    { ...options, agentStatusHooksEnabled: false }
  )
  expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
  expect(readFileSync(stalePlugin, 'utf8')).toContain('setup')
})

it.each([true, false])('strips daemon-inherited retired paths (known to main: %s)', (known) => {
  const legacy = join(fixture.userData, 'opencode-hooks', 'shared')
  if (known) {
    vi.stubEnv('OPENCODE_CONFIG_DIR', legacy)
  }
  const env = buildPtyHostEnv('pane', {}, { ...options, agentStatusHooksEnabled: false })
  vi.stubEnv('ORCA_USER_DATA_PATH', fixture.userData)
  vi.stubEnv('OPENCODE_CONFIG_DIR', legacy)
  const request = { sessionId: 'pane', cols: 80, rows: 24, cwd: root, env }
  const result = createDaemonPtyEnvironment(request)
  expect(result.OPENCODE_CONFIG_DIR).toBeUndefined()
  result.OPENCODE_CONFIG_DIR = legacy
  rescrubDaemonPtyEnvironment(result, request)
  expect(result.OPENCODE_CONFIG_DIR).toBeUndefined()
})

it('preserves explicit user config over a retired daemon-inherited path', () => {
  vi.stubEnv('ORCA_USER_DATA_PATH', fixture.userData)
  vi.stubEnv('OPENCODE_CONFIG_DIR', join(fixture.userData, 'opencode-hooks', 'shared'))
  const env = { OPENCODE_CONFIG_DIR: custom }
  const result = createDaemonPtyEnvironment({
    sessionId: 'pane',
    cols: 80,
    rows: 24,
    cwd: root,
    env
  })
  expect(result.OPENCODE_CONFIG_DIR).toBe(custom)
})

it('does not restore a retired source from process.env with hooks disabled', () => {
  vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', join(fixture.userData, 'opencode-hooks', 'shared'))
  const env = buildPtyHostEnv('pane', {}, { ...options, agentStatusHooksEnabled: false })
  expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
})

it.each([true, false])(
  'preserves explicit config with a retired parent source (hooks: %s)',
  (enabled) => {
    vi.stubEnv(
      'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      join(fixture.userData, 'opencode-hooks', 'shared')
    )
    const env = buildPtyHostEnv(
      'pane',
      { OPENCODE_CONFIG_DIR: custom },
      { ...options, agentStatusHooksEnabled: enabled }
    )
    if (enabled) {
      expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe(custom)
      expect(readFileSync(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')).toBe(
        '{"model":"fixture"}'
      )
    } else {
      expect(env.OPENCODE_CONFIG_DIR).toBe(custom)
    }
  }
)

it('repairs both legacy variants without main inheriting any retired path or enabling hooks', () => {
  for (const agent of ['opencode', 'opencode2']) {
    const path = plugin(join(fixture.userData, `${agent}-hooks`, 'shared'), agent)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '// old plugin')
  }
  buildPtyHostEnv('pane', {}, { ...options, agentStatusHooksEnabled: false })
  for (const agent of ['opencode', 'opencode2']) {
    expect(
      readFileSync(plugin(join(fixture.userData, `${agent}-hooks`, 'shared'), agent), 'utf8')
    ).toContain('setup')
  }
})
