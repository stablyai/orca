import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeStructuredAuthPolicyForSettings } from '../claude-accounts/claude-structured-auth-policy'
import { CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE } from '../claude-accounts/environment'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  CLAUDE_SESSION_STATE_EVENTS_ENV,
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeSessionIdForOrcaSession,
  createClaudeStructuredLaunchResolver
} from './claude-structured-launch-resolution'
import { ClaudeBoundHomeRefusalError } from './claude-bound-home-refusal'
import { claudeStructuredPermissionModeForSettings } from './claude-structured-permission-mode'

const SESSION_ID = 'orca-session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: [],
    ...overrides
  } as AgentSessionRecord
}

function identityAt(leafUuid: string | null): typeof IDENTITY {
  return {
    ...IDENTITY,
    providerHandle: { kind: 'claude', sessionId: 'provider-current', leafUuid }
  }
}

function makeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755)
  }
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveEnv?: () => Record<string, string>,
  stripAuthEnv = false,
  // Manual by default so a test that is not about permissions is not silently about them.
  agentDefaultArgs: Record<string, string> = { claude: '' },
  /** Deps a single test needs; kept last so the common shape stays a one-liner. */
  extraDeps: Partial<Parameters<typeof createClaudeStructuredLaunchResolver>[0]> = {}
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv }),
    resolvePermissionMode: () => claudeStructuredPermissionModeForSettings({ agentDefaultArgs }),
    // A no-op by default so a test that is not about the bound home does not need a real directory.
    assertBoundHomeUsable: async () => {},
    ...(resolveEnv ? { resolveEnv } : {}),
    ...extraDeps
  })
}

function boundRecord(binding: boolean): AgentSessionRecord {
  return record({
    providerHandleChain: RESUMABLE.providerHandleChain,
    accountHome: {
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/bound/claude-home',
      ...(binding ? { binding: { kind: 'project-group', groupId: 'group-1' } } : {})
    }
  })
}

function managedAccount(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/managed/${id}`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const HOST_SELECTED: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('host-1', 'host')],
  activeClaudeManagedAccountId: 'host-1',
  activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
}

/** The normalized steady state of a Windows user whose only Claude account is WSL-managed: the
 *  prune drops the WSL account out of the host slot and persists that. */
const WSL_ONLY_NORMALIZED: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('wsl-1', 'wsl')],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
}

const RESUMABLE = record({
  providerHandleChain: [
    { handle: { provider: 'claude', sessionId: 'provider-current', leafUuid: 'leaf-current' } }
  ] as AgentSessionRecord['providerHandleChain']
})

describe('claude structured launch resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('pre-mints a stable provider id and pins interactive setting sources', async () => {
    const first = await resolverFor(record())({ identity: IDENTITY })
    const second = await resolverFor(record())({ identity: IDENTITY })

    expect(first.providerSessionId).toBe(claudeSessionIdForOrcaSession(SESSION_ID))
    expect(second.providerSessionId).toBe(first.providerSessionId)
    expect(first).toMatchObject({
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      cwd: '/repos/workspace-1',
      claudeConfigDir: '/home/work/.claude',
      resumeLeafUuid: null,
      resumed: false
    })
    expect(first.options).toEqual({
      includePartialMessages: true,
      settingSources: [...CLAUDE_DEFAULT_SETTING_SOURCES],
      supportedDialogKinds: [],
      extraArgs: { 'replay-user-messages': null },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      sessionId: first.providerSessionId
    })
    expect(first.options.resume).toBeUndefined()
    expect(CLAUDE_STRUCTURED_BASE_OPTIONS.includePartialMessages).toBe(true)
    expect(first.env).toMatchObject({ [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1' })
  })

  it('resumes the session and leaf at the durable chain head', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          { handle: { provider: 'claude', sessionId: 'provider-old', leafUuid: 'leaf-old' } },
          {
            handle: {
              provider: 'claude',
              sessionId: 'provider-current',
              leafUuid: 'leaf-current'
            }
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: identityAt('leaf-current') })

    expect(launch).toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: 'leaf-current',
      resumed: true
    })
    expect(launch.options.resume).toBe('provider-current')
    expect(launch.options.resumeSessionAt).toBe('leaf-current')
    expect(launch.options.sessionId).toBeUndefined()
  })

  it('forces session-state events on when the inherited overlay disables them', async () => {
    const launch = await resolverFor(record(), () => ({
      [CLAUDE_SESSION_STATE_EVENTS_ENV]: '0'
    }))({ identity: IDENTITY })

    expect(launch.env).toMatchObject({ [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1' })
  })

  it('refuses a durable journal leaf that diverged before resume resolution', async () => {
    const resolve = resolverFor(
      record({
        providerHandleChain: [
          {
            handle: {
              provider: 'claude',
              sessionId: 'provider-current',
              leafUuid: 'leaf-current'
            }
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )

    await expect(resolve({ identity: identityAt('leaf-stale') })).rejects.toThrow(
      'durable resume identity changed before spawn'
    )
  })

  it('keeps session-only resume when the durable handle has no leaf', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          {
            handle: {
              provider: 'claude',
              sessionId: 'provider-current',
              leafUuid: null
            }
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: identityAt(null) })

    expect(launch.options.resume).toBe('provider-current')
    expect(launch.options.resumeSessionAt).toBeUndefined()
  })

  // Agent Permissions is stored as the bypass flag inside the launch arguments, so presence of
  // that flag — not the whole string — is what Yolo means, exactly as a terminal launch reads it.
  it.each([
    ['--dangerously-skip-permissions'],
    ['--dangerously-skip-permissions --model Opus'],
    ['--model Opus --dangerously-skip-permissions']
  ])('starts a Yolo session in bypassPermissions for args %s', async (claude) => {
    const launch = await resolverFor(record(), undefined, false, { claude })({ identity: IDENTITY })

    expect(launch.options.extraArgs).toEqual({
      'replay-user-messages': null,
      'dangerously-skip-permissions': null
    })
    expect(launch.options.permissionMode).toBeUndefined()
    expect(launch.options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  // The common profile: the toggle has never been used, so it has written nothing, and the
  // default for the key it did not write is the bypass flag — the posture the terminal has
  // always given these users.
  it('starts a session that never opened Agent settings in bypassPermissions', async () => {
    const launch = await resolverFor(record(), undefined, false, {})({ identity: IDENTITY })

    expect(launch.options.extraArgs).toEqual({
      'replay-user-messages': null,
      'dangerously-skip-permissions': null
    })
  })

  // Manual is stored as an empty string, which owns the key and so beats the shipped default.
  it.each([[''], ['--model Opus']])(
    'leaves a Manual session prompting for args %s',
    async (claude) => {
      const launch = await resolverFor(record(), undefined, false, { claude })({
        identity: IDENTITY
      })

      expect(launch.options.permissionMode).toBeUndefined()
      expect(launch.options.extraArgs).toEqual({ 'replay-user-messages': null })
      expect(launch.options.allowDangerouslySkipPermissions).toBeUndefined()
    }
  )

  // The configured CLI arguments are a terminal concern: a durable record written before they
  // stopped being read must not smuggle one back into the child.
  it("ignores the record's durable launch arguments", async () => {
    const launch = await resolverFor(
      record({
        launchArgs: ['--model', 'claude-sonnet-4-5', '--dangerously-skip-permissions']
      })
    )({ identity: IDENTITY })

    expect(launch.options.model).toBeUndefined()
    expect(launch.options.extraArgs).toEqual({ 'replay-user-messages': null })
    expect(launch.options.permissionMode).toBeUndefined()
  })

  it('keeps the session launch environment pinned after account settings change', async () => {
    const resolver = resolverFor(record(), () => ({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    }))

    expect((await resolver({ identity: IDENTITY })).env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    })
    expect((await resolver({ identity: IDENTITY })).env?.ANTHROPIC_AUTH_TOKEN).toBe('rotated-token')
  })

  // Stripping is the managed-account rule the terminal preflight computes at
  // runtime-auth-preparation.ts:72; claude-structured-auth-parity.test.ts covers
  // the system-auth half, where the user's own key has to survive.
  it('strips ambient Anthropic auth under a managed account but keeps the rest of the env', async () => {
    const restore = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ORCA_LAUNCH_RESOLUTION_MARKER: process.env.ORCA_LAUNCH_RESOLUTION_MARKER
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-SHELL-LEAK'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-SHELL-LEAK'
    process.env.ORCA_LAUNCH_RESOLUTION_MARKER = 'inherited'
    try {
      const launch = await resolverFor(record(), undefined, true)({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // The inherited env is still the base — only auth is removed from it.
      expect(launch.env?.ORCA_LAUNCH_RESOLUTION_MARKER).toBe('inherited')
      expect(launch.env?.PATH ?? launch.env?.Path).toBeTruthy()
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('lets an explicit Claude env overlay override ambient auth under system auth', async () => {
    const restore = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    try {
      const launch = await resolverFor(record(), () => ({
        ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED'
      }))({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
    } finally {
      if (restore === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = restore
      }
    }
  })

  it('pairs a resolved Claude CLI with its sibling Node runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-launch-'))
    const binDir = join(root, 'bin')
    const claudeCommand = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    const nodeCommand = join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node')
    makeExecutable(claudeCommand)
    makeExecutable(nodeCommand)

    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => claudeCommand,
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/accounts/selected/home'
      })
    })({ identity: IDENTITY })

    expect((launch.env?.PATH ?? launch.env?.Path)?.split(delimiter)[0]).toBe(binDir)
  })

  it('refuses other hosts, WSL, providers, and account-home variables', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, executionHostId: 'ssh:build' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
    await expect(
      resolverFor(record({ location: { ...record().location, wslDistro: 'Ubuntu' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
    await expect(
      resolverFor(record({ provider: 'codex' } as Partial<AgentSessionRecord>))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/codex session/)
    await expect(
      resolverFor(record({ accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
  })

  /** The account state can change while a session lives, and a reacquire after an unexpected child
   *  exit re-resolves the launch. Without the gate here, that reacquire spawns under whatever the
   *  account state has become. */
  describe('managed-account gate on every acquisition', () => {
    function resolverWithGate(read: () => ClaudeManagedAccountGateSettings | null) {
      return createClaudeStructuredLaunchResolver({
        store: { getRecord: () => RESUMABLE } as unknown as AgentSessionRecordStore,
        resolveWorkspacePath: async (id) => `/repos/${id}`,
        resolveCommand: () => '/usr/local/bin/claude',
        // Derived, not a literal: the gate and the policy must read the SAME account state, so a
        // hardcoded value could assert a pairing production cannot produce.
        resolveAuthPolicy: () => {
          const settings = read()
          if (!settings) {
            throw new Error('the gate refuses before the auth policy is computed')
          }
          return claudeStructuredAuthPolicyForSettings(settings)
        },
        readManagedAccountGate: read
      })
    }

    it('refuses a reacquire once the account state becomes the refused shape', async () => {
      let gate: ClaudeManagedAccountGateSettings | null = HOST_SELECTED
      const resolve = resolverWithGate(() => gate)

      // Created while supported: the launch resolves and would spawn.
      await expect(resolve({ identity: identityAt('leaf-current') })).resolves.toMatchObject({
        providerSessionId: 'provider-current'
      })

      gate = WSL_ONLY_NORMALIZED

      // Reacquire after the account state changed: refused before anything spawns.
      await expect(resolve({ identity: identityAt('leaf-current') })).rejects.toBeInstanceOf(
        AgentSessionPreSpawnError
      )
    })

    it('fails closed when the account state cannot be read', async () => {
      await expect(
        resolverWithGate(() => null)({ identity: identityAt('leaf-current') })
      ).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    })

    it('keeps resolving when no gate is wired, so other embedders are unaffected', async () => {
      await expect(
        resolverFor(RESUMABLE)({ identity: identityAt('leaf-current') })
      ).resolves.toMatchObject({ providerSessionId: 'provider-current' })
    })

    it('skips the gate for a project-group bound record, which is a custom home', async () => {
      // The global selection points at the shape the gate refuses; the bound home is not it.
      const resolve = resolverFor(boundRecord(true), undefined, false, undefined, {
        readManagedAccountGate: () => WSL_ONLY_NORMALIZED
      })

      await expect(resolve({ identity: identityAt('leaf-current') })).resolves.toMatchObject({
        claudeConfigDir: '/bound/claude-home'
      })
    })
  })

  describe('auth-switch settle assertion', () => {
    function resolveBound(binding: boolean) {
      return resolverFor(boundRecord(binding), undefined, false, undefined, {
        authSwitchSettleTimeoutMs: 10
      })
    }

    it('does not block a bound record mid switch, and still blocks an unbound one', async () => {
      beginClaudeAuthSwitch()
      try {
        await expect(
          resolveBound(true)({ identity: identityAt('leaf-current') })
        ).resolves.toBeDefined()
        await expect(resolveBound(false)({ identity: identityAt('leaf-current') })).rejects.toThrow(
          CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE
        )
      } finally {
        endClaudeAuthSwitch()
      }
    })

    // Was the resolver's first statement before the bound-home branch existed; an unbound caller
    // must still see the switch message rather than a record-shape error.
    it('reports an in-flight switch ahead of a missing record', async () => {
      beginClaudeAuthSwitch()
      try {
        await expect(
          resolverFor(null, undefined, false, undefined, { authSwitchSettleTimeoutMs: 10 })({
            identity: identityAt('leaf-current')
          })
        ).rejects.toThrow(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
      } finally {
        endClaudeAuthSwitch()
      }
    })
  })

  describe('bound home re-verification at acquisition', () => {
    it('re-proves the bound directory on every acquisition, not only at create', async () => {
      const assertBoundHomeUsable = vi.fn(async () => {})
      vi.stubEnv('ORCA_TEST_AMBIENT_MARKER', 'ambient')
      const resolve = resolverFor(
        boundRecord(true),
        () => ({ SOME_OVERLAY: '1' }),
        false,
        undefined,
        { assertBoundHomeUsable }
      )

      await expect(resolve({ identity: identityAt('leaf-current') })).resolves.toBeDefined()
      // The env the child actually receives, not the overlay alone: a conflicting ambient
      // CLAUDE_CONFIG_DIR reaches the CLI, so the check that refuses one has to see it too.
      expect(assertBoundHomeUsable).toHaveBeenCalledWith({
        binding: { configDir: '/bound/claude-home', groupId: 'group-1' },
        location: { executionHostId: LOCAL_EXECUTION_HOST_ID, wslDistro: null },
        launchEnv: expect.objectContaining({
          SOME_OVERLAY: '1',
          ORCA_TEST_AMBIENT_MARKER: 'ambient'
        })
      })
    })

    it('refuses the acquisition when the bound directory no longer serves it', async () => {
      const resolve = resolverFor(boundRecord(true), undefined, false, undefined, {
        assertBoundHomeUsable: async () => {
          throw new Error('claude_bound_home_signed_out')
        }
      })

      await expect(resolve({ identity: identityAt('leaf-current') })).rejects.toThrow(
        'claude_bound_home_signed_out'
      )
    })

    it('leaves an unbound record untouched by the bound-home check', async () => {
      const assertBoundHomeUsable = vi.fn(async () => {})
      await expect(
        resolverFor(boundRecord(false), undefined, false, undefined, { assertBoundHomeUsable })({
          identity: identityAt('leaf-current')
        })
      ).resolves.toBeDefined()
      expect(assertBoundHomeUsable).not.toHaveBeenCalled()
    })
  })
  describe("a binding naming the CLI's own default home", () => {
    // Binding a group to `~/.claude` pins nothing — the config-dir patch emits nothing because the
    // path is already what the CLI finds. The marker must therefore not switch off the gates that
    // exist to protect exactly that home.
    function sharedHomeRecord(): AgentSessionRecord {
      return record({
        providerHandleChain: RESUMABLE.providerHandleChain,
        accountHome: {
          variable: 'CLAUDE_CONFIG_DIR',
          path: join(homedir(), '.claude'),
          binding: { kind: 'project-group', groupId: 'group-1' }
        }
      })
    }

    it('keeps the managed-account gate', async () => {
      await expect(
        resolverFor(sharedHomeRecord(), undefined, false, undefined, {
          readManagedAccountGate: () => WSL_ONLY_NORMALIZED
        })({ identity: identityAt('leaf-current') })
      ).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    })

    it('keeps the auth-switch settle assertion', async () => {
      beginClaudeAuthSwitch()
      try {
        await expect(
          resolverFor(sharedHomeRecord(), undefined, false, undefined, {
            authSwitchSettleTimeoutMs: 10
          })({ identity: identityAt('leaf-current') })
        ).rejects.toThrow(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
      } finally {
        endClaudeAuthSwitch()
      }
    })

    it('runs no bound-home re-proof, exactly as an unbound session does not', async () => {
      const assertBoundHomeUsable = vi.fn(async () => {})
      await expect(
        resolverFor(sharedHomeRecord(), undefined, false, undefined, { assertBoundHomeUsable })({
          identity: identityAt('leaf-current')
        })
      ).resolves.toMatchObject({ claudeConfigDir: join(homedir(), '.claude') })
      expect(assertBoundHomeUsable).not.toHaveBeenCalled()
    })
  })

  describe('a group bound after the chat was created', () => {
    function resolveWithGroupBinding(
      configDir: string | null,
      accountHome: AgentSessionRecord['accountHome'] = {
        variable: 'CLAUDE_CONFIG_DIR',
        path: '/old/claude-home'
      }
    ) {
      return resolverFor(
        record({ providerHandleChain: RESUMABLE.providerHandleChain, accountHome }),
        undefined,
        false,
        undefined,
        {
          readClaudeHomeBinding: () => (configDir ? { configDir, groupId: 'group-1' } : null)
        }
      )({ identity: identityAt('leaf-current') })
    }

    // The account home is pinned at create and a resume rebuilds it verbatim, so a binding added
    // afterwards never reaches this chat. Say so rather than billing another organisation.
    it('refuses by name instead of silently keeping the old home', async () => {
      const error = await resolveWithGroupBinding('/bound/claude-home').then(
        () => null,
        (thrown: unknown) => (thrown instanceof ClaudeBoundHomeRefusalError ? thrown : null)
      )

      expect(error?.refusal).toEqual({
        code: 'claude_bound_home_predates_binding',
        groupId: 'group-1',
        configDir: '/bound/claude-home',
        accountHomePath: '/old/claude-home'
      })
      // Both homes are named, so the user can see which chat is on which account.
      expect(error?.message).toContain('/old/claude-home')
      expect(error?.message).toContain('/bound/claude-home')
    })

    it("says nothing when the chat already runs under the group's home", async () => {
      await expect(
        resolveWithGroupBinding('/bound/claude-home', {
          variable: 'CLAUDE_CONFIG_DIR',
          path: '/bound/claude-home',
          binding: { kind: 'project-group', groupId: 'group-1' }
        })
      ).resolves.toBeDefined()
    })

    it('says nothing when the group binds nothing', async () => {
      await expect(resolveWithGroupBinding(null)).resolves.toBeDefined()
    })
  })
})
