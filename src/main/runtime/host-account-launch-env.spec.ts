import { describe, expect, it, vi } from 'vitest'
import { HostAccountLaunchEnvParams } from '../../shared/host-account-launch-env'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { RuntimeAccountController, type RuntimeAccountServices } from './runtime-account-controller'
import { withHostAccountLaunchEnv } from './runtime-agent-terminal-startup'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export function registerHostAccountLaunchEnvTests(): void {
  const LAUNCH_ENV = HostAccountLaunchEnvParams.parse({
    wslDistro: 'Ubuntu',
    claude: {
      CLAUDE_CONFIG_DIR: '/home/u/.orca/claude/a',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/home/u/.orca/claude/a',
      CODEX_HOME: '/home/u/.orca/codex/b'
    },
    terminal: {
      ORCA_CLAUDE_PROFILE_POINTER: '~/.orca/claude-pointer',
      CODEX_HOME: '/home/u/.orca/codex/b'
    }
  })

  describe('RuntimeAccountController host launch env', () => {
    it('gives claude the selected home and every other process the pointer and Codex home', () => {
      const accounts = new RuntimeAccountController()
      expect(accounts.hostLaunchEnvFor('claude')).toEqual({})
      accounts.setHostLaunchEnv(LAUNCH_ENV)
      expect(accounts.hostLaunchEnvFor('claude')).toEqual(LAUNCH_ENV.claude)
      expect(accounts.hostLaunchEnvFor('codex')).toEqual(LAUNCH_ENV.terminal)
      expect(accounts.hostLaunchEnvFor(null)).toEqual(LAUNCH_ENV.terminal)
    })

    it('refuses where the host has account services of its own', () => {
      const accounts = new RuntimeAccountController()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only presence is read.
      accounts.setServices({} as RuntimeAccountServices)
      expect(() => accounts.setHostLaunchEnv(LAUNCH_ENV)).toThrow(/its own provider accounts/)
    })

    it('points `orca account` at the desktop that owns the accounts', () => {
      const accounts = new RuntimeAccountController()
      expect(() => accounts.getSnapshot()).toThrow('Account services are not configured')
      accounts.setHostLaunchEnv(LAUNCH_ENV)
      expect(() => accounts.getSnapshot()).toThrow(/Orca desktop app.*Ubuntu \(WSL\)/)
    })

    it('runs AI commit text under the selected accounts', async () => {
      const accounts = new RuntimeAccountController()
      accounts.setHostLaunchEnv(LAUNCH_ENV)
      const resolvers = accounts.getCommitMessageAgentEnvironment()
      const codex = await prepareLocalCommitMessageAgentEnv('codex', resolvers)
      const claude = await prepareLocalCommitMessageAgentEnv('claude', resolvers)
      expect(codex.ok && codex.env?.CODEX_HOME).toBe('/home/u/.orca/codex/b')
      expect(claude.ok && claude.env?.CLAUDE_CONFIG_DIR).toBe('/home/u/.orca/claude/a')
    })
  })

  describe('withHostAccountLaunchEnv', () => {
    it("lays the account over the launch plan's env, as a desktop launch does", () => {
      expect(
        withHostAccountLaunchEnv(
          {},
          {
            command: 'claude',
            env: { KEEP: '1', CLAUDE_CONFIG_DIR: '/agent-default' }
          },
          LAUNCH_ENV.claude
        ).env
      ).toEqual({ KEEP: '1', ...LAUNCH_ENV.claude })
    })

    it('keeps what the caller passed: its env and its own accountEnv win', () => {
      const requested = {
        env: { CODEX_HOME: '/caller' },
        accountEnv: { CLAUDE_CONFIG_DIR: '/hint' }
      }
      expect(
        withHostAccountLaunchEnv(requested, { env: requested.env }, LAUNCH_ENV.claude).env
      ).toMatchObject({ CODEX_HOME: '/caller', CLAUDE_CONFIG_DIR: '/hint' })
    })

    it('gives a plain shell the env and leaves a launch untouched with none', () => {
      expect(withHostAccountLaunchEnv({}, {}, LAUNCH_ENV.terminal).env).toEqual(LAUNCH_ENV.terminal)
      const launch = { command: 'ls' }
      expect(withHostAccountLaunchEnv({}, launch, {})).toBe(launch)
    })
  })

  describe('launches a WSL host starts on its own', () => {
    function runtimeWithHostAccounts(): OrcaRuntimeService {
      const store = {
        getSettings: () => ({
          disabledTuiAgents: [],
          agentCmdOverrides: {},
          agentDefaultArgs: {},
          agentDefaultEnv: {
            claude: { KEEP: '1', CLAUDE_CONFIG_DIR: '/agent-default' }
          }
        })
      }
      const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
      runtime.setHostAccountLaunchEnv(LAUNCH_ENV)
      return runtime
    }

    it('gives every terminal create the selected accounts (CLI, presets, automations)', async () => {
      const runtime = runtimeWithHostAccounts()
      const workspace = {
        id: 'wt-1',
        path: '/home/u/repo',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      }
      const launch = await runtime['resolveAgentTerminalCreateOptions'](workspace, {})
      expect(launch.env).toEqual(LAUNCH_ENV.terminal)
    })

    it("leaves an SSH workspace's terminal alone: its shell runs on another machine", async () => {
      const runtime = runtimeWithHostAccounts()
      const workspace = {
        id: 'wt-ssh',
        path: '/srv/repo',
        connectionId: 'ssh-1',
        repo: null,
        folderWorkspace: null
      }
      const launch = await runtime['resolveAgentTerminalCreateOptions'](workspace, {})
      expect(launch.env).toBeUndefined()
    })

    it("pins a structured chat to the selected account's home", () => {
      const runtime = runtimeWithHostAccounts()
      const settings = {
        agentDefaultEnv: { claude: { KEEP: '1', CLAUDE_CONFIG_DIR: '/agent-default' } }
      }
      expect(runtime['structuredAgentLaunchEnv']('claude', settings)).toEqual({
        KEEP: '1',
        ...LAUNCH_ENV.claude
      })
    })
  })

  describe('restoreHostLaunchEnv', () => {
    it('starts from the saved env and saves every later push', () => {
      const accounts = new RuntimeAccountController()
      const saved: unknown[] = []
      accounts.restoreHostLaunchEnv(LAUNCH_ENV, (launchEnv) => saved.push(launchEnv))
      expect(accounts.hostLaunchEnvFor('codex')).toEqual(LAUNCH_ENV.terminal)
      const next = { ...LAUNCH_ENV, terminal: {} }
      accounts.setHostLaunchEnv(next)
      expect(saved).toEqual([next])
    })

    it('keeps applying a push whose save failed', () => {
      const accounts = new RuntimeAccountController()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      accounts.restoreHostLaunchEnv(null, () => {
        throw new Error('disk full')
      })
      accounts.setHostLaunchEnv(LAUNCH_ENV)
      expect(accounts.hostLaunchEnvFor('claude')).toEqual(LAUNCH_ENV.claude)
      vi.restoreAllMocks()
    })
  })
}
