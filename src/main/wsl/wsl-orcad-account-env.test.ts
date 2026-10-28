import { describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import {
  guestCodexHomePath,
  prepareWslOrcadAccountEnv,
  withWslOrcadAccountEnv,
  type WslOrcadAccountEnvDependencies
} from './wsl-orcad-account-env'
import type { WslOrcadHostCapabilityVerdict } from './wsl-orcad-host-environments'
import { AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY } from '../../shared/agent-session-create-capabilities'
import { CODEX_STORE_OVERLAY_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'

const POINTER = '~/.orca-claude-profile-pointer-test'
const CLAUDE_HOME = '/home/u/.orca/claude-accounts/acct-a/config'

function claudeLaunch(
  overrides: Partial<ClaudeRuntimeAuthPreparation> = {}
): ClaudeRuntimeAuthPreparation {
  return {
    configDir: '\\\\wsl.localhost\\Ubuntu\\home\\u\\.orca\\claude-accounts\\acct-a\\config',
    runtime: 'wsl',
    wslDistro: 'Ubuntu',
    wslLinuxConfigDir: CLAUDE_HOME,
    envPatch: {
      ORCA_CLAUDE_PROFILE_POINTER: POINTER,
      CLAUDE_CONFIG_DIR: CLAUDE_HOME,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: CLAUDE_HOME
    },
    provenance: 'profile:acct-a:wsl:Ubuntu',
    ...overrides
  }
}

function dependencies(
  overrides: Partial<WslOrcadAccountEnvDependencies> = {}
): WslOrcadAccountEnvDependencies {
  return {
    prepareClaudeLaunch: vi.fn(async () => claudeLaunch()),
    claudeTerminalEnv: vi.fn(() => ({ ORCA_CLAUDE_PROFILE_POINTER: POINTER })),
    prepareCodexHome: vi.fn(async () => '\\\\wsl.localhost\\Ubuntu\\home\\u\\.orca\\codex-b'),
    managedAccountSelected: vi.fn(() => true),
    accountNotApplied: vi.fn(),
    ...overrides
  }
}

describe('prepareWslOrcadAccountEnv', () => {
  it('gives a Claude launch the selected account folder and the Codex home', async () => {
    const deps = dependencies()
    await expect(prepareWslOrcadAccountEnv('Ubuntu', 'claude', deps)).resolves.toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: POINTER,
      CLAUDE_CONFIG_DIR: CLAUDE_HOME,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: CLAUDE_HOME,
      CODEX_HOME: '/home/u/.orca/codex-b'
    })
    expect(deps.prepareClaudeLaunch).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('gives every other process only the Claude pointer, never waiting on Claude setup', async () => {
    const deps = dependencies()
    await expect(prepareWslOrcadAccountEnv('Ubuntu', 'codex', deps)).resolves.toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: POINTER,
      CODEX_HOME: '/home/u/.orca/codex-b'
    })
    expect(deps.prepareClaudeLaunch).not.toHaveBeenCalled()
  })

  it('sends only the pointer for System default on both', async () => {
    const deps = dependencies({
      prepareClaudeLaunch: async () =>
        claudeLaunch({ envPatch: { ORCA_CLAUDE_PROFILE_POINTER: POINTER } }),
      prepareCodexHome: async () => null
    })
    await expect(prepareWslOrcadAccountEnv('Ubuntu', 'claude', deps)).resolves.toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: POINTER
    })
  })

  it("drops a preparation for another runtime or distro rather than send a host's path", async () => {
    const deps = dependencies({
      prepareClaudeLaunch: async () =>
        claudeLaunch({ runtime: 'host', envPatch: { CLAUDE_CONFIG_DIR: '/Users/u/.claude-a' } }),
      prepareCodexHome: async () => '\\\\wsl.localhost\\Debian\\home\\u\\.codex-b'
    })
    await expect(prepareWslOrcadAccountEnv('Ubuntu', 'claude', deps)).resolves.toEqual({})
  })

  it('refuses a home it cannot send', async () => {
    const deps = dependencies({ claudeTerminalEnv: () => ({ ORCA_CLAUDE_PROFILE_POINTER: 'x' }) })
    await expect(prepareWslOrcadAccountEnv('Ubuntu', null, deps)).rejects.toThrow(
      'not a usable path'
    )
  })
})

describe('guestCodexHomePath', () => {
  it('reads UNC and guest paths, case-insensitive on the distro', () => {
    expect(guestCodexHomePath('\\\\wsl$\\ubuntu\\home\\u\\.codex', 'Ubuntu')).toBe('/home/u/.codex')
    expect(guestCodexHomePath('/home/u//.codex', 'Ubuntu')).toBe('/home/u/.codex')
    expect(guestCodexHomePath('C:\\Users\\u\\.codex', 'Ubuntu')).toBeNull()
  })
})

describe('withWslOrcadAccountEnv', () => {
  const wsl = (id: string) => (id === 'wsl:ubuntu' ? 'Ubuntu' : null)
  const run = (
    method: string,
    params: unknown,
    deps = dependencies(),
    id = 'wsl:ubuntu',
    hostSupports: (capability: string) => Promise<WslOrcadHostCapabilityVerdict> = async () =>
      'supported'
  ) => withWslOrcadAccountEnv({ environmentId: id, method, params, hostSupports }, deps, wsl)

  it('leaves calls to any other environment untouched', async () => {
    const params = { worktree: 'id:wt' }
    const deps = dependencies()
    await expect(run('terminal.create', params, deps, 'ssh-1')).resolves.toEqual({
      ok: true,
      params
    })
    expect(deps.prepareCodexHome).not.toHaveBeenCalled()
  })

  it('adds the env to a plain shell and over a caller-built agent launch', async () => {
    await expect(run('terminal.create', { worktree: 'id:wt' })).resolves.toMatchObject({
      params: { env: { ORCA_CLAUDE_PROFILE_POINTER: POINTER, CODEX_HOME: '/home/u/.orca/codex-b' } }
    })
    const created = await run('session.tabs.createTerminal', {
      worktree: 'id:wt',
      command: 'claude',
      launchAgent: 'claude',
      env: { CLAUDE_CONFIG_DIR: '/stale', KEEP: '1' }
    })
    expect(created).toMatchObject({
      params: { env: { KEEP: '1', CLAUDE_CONFIG_DIR: CLAUDE_HOME } }
    })
  })

  it('never turns a bare command or agent preset into a caller-built launch', async () => {
    const bare = { worktree: 'id:wt', command: 'claude' }
    await expect(run('terminal.create', bare)).resolves.toEqual({ ok: true, params: bare })
    const preset = { worktree: 'id:wt', agent: 'codex' }
    await expect(run('session.tabs.createTerminal', preset)).resolves.toEqual({
      ok: true,
      params: preset
    })
  })

  it('sets agent.launch accountEnv, except for a reused terminal', async () => {
    const launch = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt' } }
    await expect(run('agent.launch', launch)).resolves.toMatchObject({
      params: { accountEnv: { CLAUDE_CONFIG_DIR: CLAUDE_HOME } }
    })
    const reused = { ...launch, reuseTerminal: { handle: 'term_1' } }
    await expect(run('agent.launchReplay', reused)).resolves.toEqual({ ok: true, params: reused })
  })

  it('sends overlays only to hosts that advertise store routing', async () => {
    const account = '/home/u/.local/share/orca/codex-accounts/account-a'
    const overlay = `${account}/overlays/${'a'.repeat(32)}`
    const deps = dependencies({ prepareCodexHome: async () => overlay })
    for (const capability of ['supported', 'unsupported', 'unknown'] as const) {
      const supports = vi.fn(async () => capability)
      await expect(
        run('terminal.create', { worktree: 'id:wt' }, deps, 'wsl:ubuntu', supports)
      ).resolves.toMatchObject({
        params: {
          env: {
            CODEX_HOME: capability === 'supported' ? overlay : `${account}/home`
          }
        }
      })
      expect(supports).toHaveBeenCalledWith(CODEX_STORE_OVERLAY_RUNTIME_CAPABILITY)
    }
  })

  it('refuses the call when the account cannot be prepared', async () => {
    const deps = dependencies({
      prepareClaudeLaunch: async () => {
        throw new Error('The selected Claude account could not be set up.')
      }
    })
    await expect(
      run('agent.launch', { agent: 'claude', target: { kind: 'existing', worktree: 'x' } }, deps)
    ).resolves.toEqual({ ok: false, message: 'The selected Claude account could not be set up.' })
  })

  it('ignores methods that start no process', async () => {
    const deps = dependencies()
    await expect(run('terminal.list', {}, deps)).resolves.toEqual({ ok: true, params: {} })
    expect(deps.prepareCodexHome).not.toHaveBeenCalled()
  })

  describe('agent-session creates (strict schemas, capability-gated)', () => {
    const create = { clientOperationId: 'op', worktree: 'id:wt', agent: 'claude' }
    const resume = {
      kind: 'explicit',
      worktree: 'id:wt',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's-1' }
    }

    it('sets accountEnv on createAgentSession and an explicit ensure for an advertising host', async () => {
      const hostSupports = vi.fn(async () => 'supported' as const)
      const deps = dependencies()
      await expect(
        run('terminal.createAgentSession', create, deps, 'wsl:ubuntu', hostSupports)
      ).resolves.toEqual({
        ok: true,
        params: {
          ...create,
          accountEnv: {
            ORCA_CLAUDE_PROFILE_POINTER: POINTER,
            CLAUDE_CONFIG_DIR: CLAUDE_HOME,
            ORCA_CLAUDE_INJECTED_CONFIG_DIR: CLAUDE_HOME,
            CODEX_HOME: '/home/u/.orca/codex-b'
          }
        }
      })
      expect(hostSupports).toHaveBeenCalledWith(AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY)
      await expect(
        run('terminal.ensureAgentSession', resume, deps, 'wsl:ubuntu', hostSupports)
      ).resolves.toMatchObject({ params: { accountEnv: { CODEX_HOME: '/home/u/.orca/codex-b' } } })
      expect(deps.accountNotApplied).not.toHaveBeenCalled()
    })

    it('leaves the call as is and tells the user once the host is older', async () => {
      const deps = dependencies()
      const older = async () => 'unsupported' as const
      await expect(
        run('terminal.createAgentSession', create, deps, 'wsl:ubuntu', older)
      ).resolves.toEqual({ ok: true, params: create })
      await expect(
        run('terminal.ensureAgentSession', resume, deps, 'wsl:ubuntu', older)
      ).resolves.toEqual({ ok: true, params: resume })
      expect(deps.prepareCodexHome).not.toHaveBeenCalled()
      expect(deps.accountNotApplied).toHaveBeenCalledWith('Ubuntu')
    })

    it('stays silent on an older host when no managed account is selected', async () => {
      const deps = dependencies({ managedAccountSelected: vi.fn(() => false) })
      await run(
        'terminal.createAgentSession',
        create,
        deps,
        'wsl:ubuntu',
        async () => 'unsupported'
      )
      expect(deps.accountNotApplied).not.toHaveBeenCalled()
    })

    it('treats an unanswered capability probe as unknown: no field, no notice', async () => {
      const deps = dependencies()
      await expect(
        run('terminal.createAgentSession', create, deps, 'wsl:ubuntu', async () => 'unknown')
      ).resolves.toEqual({ ok: true, params: create })
      expect(deps.accountNotApplied).not.toHaveBeenCalled()
    })

    it('never probes or patches an automatic ensure or another environment', async () => {
      const hostSupports = vi.fn(async () => 'supported' as const)
      const automatic = { kind: 'automatic', sleepingCheckpointId: 'x'.repeat(32) }
      await expect(
        run('terminal.ensureAgentSession', automatic, dependencies(), 'wsl:ubuntu', hostSupports)
      ).resolves.toEqual({ ok: true, params: automatic })
      await expect(
        run('terminal.createAgentSession', create, dependencies(), 'ssh-1', hostSupports)
      ).resolves.toEqual({ ok: true, params: create })
      expect(hostSupports).not.toHaveBeenCalled()
    })
  })
})
