import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenCodeCliCapabilities } from '../../shared/opencode-cli-version'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_SHELL_ENV
} from '../../shared/opencode-startup-prompt'
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

const hookServer = vi.hoisted(() => {
  const server: { endpointFilePath: string | null } = { endpointFilePath: '/private/endpoint.env' }
  return server
})
vi.mock('../agent-hooks/server', () => ({ agentHookServer: hookServer }))
const reserve = vi.hoisted(() => vi.fn(() => true))
vi.mock('./opencode-startup-prompt-owner', () => ({ reserveOpenCodeStartupPrompt: reserve }))

async function prepare(options: Parameters<typeof prepareOpenCodePtyLaunch>[0]) {
  return (await prepareOpenCodePtyLaunch(options)).env
}

const probe = vi.hoisted(() => vi.fn())
const install = vi.hoisted(() => vi.fn())
vi.mock('./opencode-startup-prompt-installer', () => ({
  installOpenCodeStartupPromptForLaunch: install
}))
vi.mock('./opencode-launch-capabilities', () => ({ probeOpenCodeLaunchCapabilities: probe }))

beforeEach(() => {
  probe.mockReset()
  reserve.mockReset().mockReturnValue(true)
  install.mockReset()
  hookServer.endpointFilePath = '/private/endpoint.env'
})
afterEach(() => vi.unstubAllEnvs())

describe('execution-host OpenCode launch preparation', () => {
  it('retains fresh owned source provenance through the final provider deletion pass', async () => {
    probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
    install.mockImplementation((env) => {
      env.OPENCODE_CONFIG_DIR = '/private/owned-overlay'
      env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = '/private/real-source'
      return true
    })
    const envToDelete = ['OPENCODE_CONFIG_DIR', 'ORCA_OPENCODE_SOURCE_CONFIG_DIR']
    const env = await prepare({
      command: 'opencode --prompt task',
      isFreshLaunch: true,
      envToDelete,
      env: {
        ORCA_AGENT_LAUNCH_TOKEN: 'admitted-launch',
        ORCA_OPENCODE_STARTUP_PROMPT_SHA256: createHash('sha256').update('task').digest('hex'),
        ORCA_OPENCODE_STARTUP_PROMPT_BODY: 'task',
        ORCA_OPENCODE_STARTUP_PROMPT_SHELL: 'posix'
      }
    })
    const finalEnv = await buildLocalPtySpawnEnvironment({
      id: 'source-proof',
      spawn: { cols: 80, rows: 24, env, envToDelete },
      getOptions: () => ({}),
      plan
    })
    enforceLocalPtySpawnEnvironmentOverrides({ cols: 80, rows: 24, env, envToDelete }, finalEnv)
    expect(finalEnv.OPENCODE_CONFIG_DIR).toBe('/private/owned-overlay')
    expect(finalEnv.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBe('/private/real-source')
  })
  it.each(['2.0.12', '2.0.16'])(
    'removes only the automatic %s prompt argument, retaining explicit run and manual flags',
    async (version) => {
      probe.mockResolvedValue(getOpenCodeCliCapabilities(version))
      const env = {
        ORCA_AGENT_LAUNCH_TOKEN: 'admitted-launch',
        [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: createHash('sha256').update('task').digest('hex'),
        [OPENCODE_STARTUP_PROMPT_BODY_ENV]: 'task',
        [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: 'posix'
      }
      const options = { env, envToDelete: [], isFreshLaunch: true }
      expect(
        (
          await prepareOpenCodePtyLaunch({
            ...options,
            command: "opencode --standalone --prompt 'task'"
          })
        ).command
      ).toBe('opencode --standalone')
      expect(
        (await prepareOpenCodePtyLaunch({ ...options, command: "opencode run --prompt 'task'" }))
          .command
      ).toBe("opencode run --prompt 'task'")
      expect(
        (
          await prepareOpenCodePtyLaunch({
            ...options,
            env: {},
            command: "opencode --prompt 'task'"
          })
        ).command
      ).toBe("opencode --prompt 'task'")
    }
  )
  it.each(['inherited', 'explicit', 'deleted'] as const)(
    'passes the %s config environment used by the execution-host version probe to the prompt installer',
    async (selection) => {
      vi.stubEnv('XDG_CONFIG_HOME', '/ambient/config')
      probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
      await prepareOpenCodePtyLaunch({
        command: 'opencode --prompt task',
        envToDelete: selection === 'deleted' ? ['XDG_CONFIG_HOME'] : [],
        isFreshLaunch: true,
        env: {
          ORCA_AGENT_LAUNCH_TOKEN: 'admitted-launch',
          [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: createHash('sha256').update('task').digest('hex'),
          [OPENCODE_STARTUP_PROMPT_BODY_ENV]: 'task',
          [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: 'posix',
          ...(selection === 'explicit' ? { XDG_CONFIG_HOME: '/selected/config' } : {})
        }
      })
      expect(install).toHaveBeenCalledTimes(1)
      const resolved = install.mock.calls[0][2]
      expect(resolved).toEqual(probe.mock.calls[0][0].env)
      expect(resolved.XDG_CONFIG_HOME).toBe(
        selection === 'deleted'
          ? undefined
          : selection === 'explicit'
            ? '/selected/config'
            : '/ambient/config'
      )
    }
  )

  it.each(['endpoint', 'installer', 'capacity', 'identity'])(
    'keeps the editable brief when automatic preparation lacks %s',
    async (failure) => {
      probe.mockResolvedValue(getOpenCodeCliCapabilities('2.0.16'))
      if (failure === 'endpoint') {
        hookServer.endpointFilePath = null
      }
      if (failure === 'installer') {
        install.mockImplementation((env) => {
          delete env.ORCA_OPENCODE_STARTUP_PROMPT_NONCE
        })
      }
      if (failure === 'capacity') {
        reserve.mockReturnValue(false)
      }
      const original = "opencode --standalone --prompt 'task'"
      const result = await prepareOpenCodePtyLaunch({
        command: original,
        envToDelete: [],
        isFreshLaunch: true,
        env: {
          ...(failure === 'identity' ? {} : { ORCA_AGENT_LAUNCH_TOKEN: 'admitted-launch' }),
          [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: createHash('sha256').update('task').digest('hex'),
          [OPENCODE_STARTUP_PROMPT_BODY_ENV]: 'task',
          [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: 'posix'
        }
      })
      expect(result.command).toBe(original)
      expect(result.env).not.toHaveProperty('ORCA_OPENCODE_STARTUP_PROMPT_NONCE')
    }
  )
  it.each([
    { version: '1.1.23', nativeIntent: false },
    { version: '2.0.12', nativeIntent: true },
    { version: '2.0.16', nativeIntent: true },
    { version: '2.0.17', nativeIntent: false },
    { version: '2.0.21', nativeIntent: false },
    { version: 'unknown', nativeIntent: false }
  ])(
    'gates native intent against the executing $version capability',
    async ({ version, nativeIntent }) => {
      probe.mockResolvedValue(getOpenCodeCliCapabilities(version))
      const envToDelete: string[] = []
      const fingerprint = createHash('sha256').update('task').digest('hex')
      const env = await prepare({
        command: 'opencode --prompt task',
        env: {
          ORCA_AGENT_LAUNCH_TOKEN: 'admitted-launch',
          [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: fingerprint,
          [OPENCODE_STARTUP_PROMPT_BODY_ENV]: 'task',
          [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: 'posix'
        },
        envToDelete,
        isFreshLaunch: true
      })
      expect(env?.[OPENCODE_STARTUP_PROMPT_SHA256_ENV]).toBe(nativeIntent ? fingerprint : undefined)
      expect(envToDelete.includes(OPENCODE_STARTUP_PROMPT_SHA256_ENV)).toBe(!nativeIntent)
    }
  )

  it('refuses remote automatic intent without execution-owned driving input', async () => {
    const fingerprint = 'b'.repeat(64)
    const envToDelete: string[] = []
    const env = await prepare({
      command: 'opencode --prompt task',
      connectionId: 'remote',
      isFreshLaunch: true,
      env: { [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: fingerprint },
      envToDelete
    })
    expect(env?.[OPENCODE_STARTUP_PROMPT_SHA256_ENV]).toBeUndefined()
    expect(envToDelete).toContain(OPENCODE_STARTUP_PROMPT_SHA256_ENV)
    expect(probe).not.toHaveBeenCalled()
  })
  it('keeps deleted credentials and config absent from the probe and final provider environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'dummy-deleted-key')
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/dummy/deleted-config')
    vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', 'v1')
    probe.mockResolvedValue(getOpenCodeCliCapabilities(null))
    const envToDelete = ['ANTHROPIC_API_KEY', 'OPENCODE_CONFIG_DIR']
    const env = await prepare({
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
    const env = await prepare({
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

  it.each(['1.1.23', '2.0.12', '2.0.16'])(
    'selects the probed %s plugin for the execution host',
    async (version) => {
      const capabilities = getOpenCodeCliCapabilities(version)
      probe.mockResolvedValue(capabilities)
      const env = {
        KEEP: '1',
        ORCA_OPENCODE_PLUGIN_API: 'stale'
      }
      const result = await prepare({
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
      await prepare({
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
    const result = await prepare({
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
      expect(await prepare({ command: 'opencode', env, envToDelete: [], ...route })).toEqual({})
      expect(probe).not.toHaveBeenCalled()
      expect(env).toEqual({ ORCA_OPENCODE_PLUGIN_API: 'v1' })
    }
  )
})
