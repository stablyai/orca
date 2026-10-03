import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'
import {
  buildLocalPtySpawnEnvironment,
  enforceLocalPtySpawnEnvironmentOverrides
} from '../providers/local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from '../providers/local-pty-launch-plan'

const plan: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '',
  cwd: '',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  shellArgs: [],
  effectiveCwd: '',
  validationCwd: '',
  startupCommandDeliveredInShellArgs: false,
  windowsFallbackAttempts: [],
  shellReadyLaunch: null,
  getFallbackShellReadyConfig: undefined,
  primaryPreLaunchEnv: {},
  isWslShell: false,
  launchWslDistro: null
}

const probe = vi.hoisted(() => vi.fn())
vi.mock('./opencode-launch-capabilities', () => ({ probeOpenCodeLaunchCapabilities: probe }))

beforeEach(() => probe.mockReset())
afterEach(() => vi.unstubAllEnvs())

describe('execution-host OpenCode launch preparation', () => {
  it('keeps deleted credentials and config absent from the probe and final provider environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'dummy-deleted-key')
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/dummy/deleted-config')
    vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', 'v1')
    probe.mockResolvedValue(getOpenCodeCliCapabilities(null))
    const envToDelete = ['ANTHROPIC_API_KEY', 'OPENCODE_CONFIG_DIR']
    const env = await prepareOpenCodePtyLaunch({
      command: 'opencode',
      env: {},
      envToDelete,
      isFreshLaunch: true
    })
    const probeEnv = probe.mock.calls[0]?.[0].env
    expect(probeEnv).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(probeEnv).not.toHaveProperty('OPENCODE_CONFIG_DIR')
    expect(probeEnv).not.toHaveProperty('ORCA_OPENCODE_PLUGIN_API')
    const finalEnv = await buildLocalPtySpawnEnvironment({
      id: 'probe',
      spawn: { cols: 80, rows: 24, env, envToDelete },
      getOptions: () => ({}),
      plan
    })
    enforceLocalPtySpawnEnvironmentOverrides({ cols: 80, rows: 24, env, envToDelete }, finalEnv)
    expect(finalEnv).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(finalEnv).not.toHaveProperty('OPENCODE_CONFIG_DIR')
    expect(finalEnv).not.toHaveProperty('ORCA_OPENCODE_PLUGIN_API')
  })

  it('retains a verified selection through the final provider deletion pass', async () => {
    vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', 'v1')
    probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
    const envToDelete = ['KEEP_DELETED', 'ORCA_OPENCODE_PLUGIN_API']
    const env = await prepareOpenCodePtyLaunch({
      command: 'opencode',
      env: {},
      envToDelete,
      isFreshLaunch: true
    })
    const finalEnv = await buildLocalPtySpawnEnvironment({
      id: 'probe',
      spawn: { cols: 80, rows: 24, env, envToDelete },
      getOptions: () => ({}),
      plan
    })
    finalEnv.KEEP_DELETED = 'dummy'
    enforceLocalPtySpawnEnvironmentOverrides({ cols: 80, rows: 24, env, envToDelete }, finalEnv)
    expect(finalEnv.ORCA_OPENCODE_PLUGIN_API).toBe('v2')
    expect(finalEnv).not.toHaveProperty('KEEP_DELETED')
  })

  it.each(['1.1.23', '2.0.16'])(
    'selects the probed %s plugin for the execution host',
    async (version) => {
      const capabilities = getOpenCodeCliCapabilities(version)
      probe.mockResolvedValue(capabilities)
      const env = {
        KEEP: '1',
        ORCA_OPENCODE_PLUGIN_API: 'stale'
      }
      const result = await prepareOpenCodePtyLaunch({
        command: 'opencode --prompt test',
        agent: 'opencode',
        env,
        envToDelete: [],
        cwd: '/repo',
        isFreshLaunch: true
      })
      expect(result).toEqual({ KEEP: '1', ORCA_OPENCODE_PLUGIN_API: capabilities.pluginApi })
      expect(env).toEqual({ KEEP: '1', ORCA_OPENCODE_PLUGIN_API: 'stale' })
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'opencode --prompt test',
          cwd: '/repo',
          env: expect.objectContaining({ KEEP: '1' })
        })
      )
    }
  )

  it('creates a launch environment for a known binary without caller env', async () => {
    probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
    expect(
      await prepareOpenCodePtyLaunch({
        command: 'opencode',
        env: undefined,
        envToDelete: [],
        isFreshLaunch: true
      })
    ).toEqual({ ORCA_OPENCODE_PLUGIN_API: 'v2' })
  })

  it('forwards WSL plugin selection through WSLENV after a guest probe', async () => {
    probe.mockResolvedValue(getOpenCodeCliCapabilities('1.1.23'))
    const env = { KEEP: '1' }
    const result = await prepareOpenCodePtyLaunch({
      command: 'opencode',
      agent: 'opencode',
      env,
      envToDelete: [],
      isFreshLaunch: true,
      wsl: { distro: 'Ubuntu' }
    })
    expect(result).toMatchObject({
      ORCA_OPENCODE_PLUGIN_API: 'v1',
      WSLENV: 'ORCA_OPENCODE_PLUGIN_API'
    })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ wsl: { distro: 'Ubuntu' } }))
  })

  it.each([{ connectionId: 'remote', isFreshLaunch: true }, { isFreshLaunch: false }])(
    'never probes the client for an attach or SSH launch',
    async (route) => {
      const env = { ORCA_OPENCODE_PLUGIN_API: 'v1' }
      expect(
        await prepareOpenCodePtyLaunch({ command: 'opencode', env, envToDelete: [], ...route })
      ).toEqual({})
      expect(probe).not.toHaveBeenCalled()
      expect(env).toEqual({ ORCA_OPENCODE_PLUGIN_API: 'v1' })
    }
  )
})
