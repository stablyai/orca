import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeStructuredAuthPolicyForSettings } from '../claude-accounts/claude-structured-auth-policy'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  CLAUDE_SESSION_STATE_EVENTS_ENV,
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeSessionIdForOrcaSession,
  createClaudeStructuredLaunchResolver,
  type ClaudeStructuredLaunchResolverDeps
} from './claude-structured-launch-resolution'
import { claudeStructuredPermissionModeForSettings } from './claude-structured-permission-mode'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

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
    providerHandle: claudeProviderHandle('provider-current', leafUuid)
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
  hasTranscript: () => Promise<boolean> = async () => true
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv }),
    resolvePermissionMode: () => claudeStructuredPermissionModeForSettings({ agentDefaultArgs }),
    hasTranscript,
    ...(resolveEnv ? { resolveEnv } : {})
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
  providerHandleChain: [
    { handle: claudeProviderHandle('provider-current', 'leaf-current') }
  ] as AgentSessionRecord['providerHandleChain']
})

describe('claude structured launch resolution', () => {
  it('resumes a floating session in its pinned folder, not the current floating setting', async () => {
    const pinned = mkdtempSync(join(tmpdir(), 'orca-claude-floating-'))
    const floating = record({
      location: { ...record().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: pinned
    })

    const launch = await resolverFor(floating)({ identity: IDENTITY })

    // resolverFor answers `/repos/<id>` — the current setting — which a pinned resume must ignore.
    expect(launch.cwd).toBe(pinned)
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
      resumesTranscript: false,
      continuesChain: false
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

  it('resumes the durable chain head by session id and carries its leaf as bookkeeping', async () => {
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
        providerHandleChain: [
          { handle: claudeProviderHandle('provider-old', 'leaf-old') },
          {
            handle: claudeProviderHandle('provider-current', 'leaf-current')
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: identityAt('leaf-current') })

    expect(launch).toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: 'leaf-current',
      resumesTranscript: true,
      continuesChain: true
    })
    expect(launch.options.resume).toBe('provider-current')
    // Claude owns where the conversation continues; a stored leaf would cut or branch it.
    expect(launch.options).not.toHaveProperty('resumeSessionAt')
    expect(launch.options.sessionId).toBeUndefined()
  })

  it('names the child by the Orca session id, over any id the configured overlay carries', async () => {
    // The Orca-minted id, never the provider's: the provider id rotates on /clear.
    const launch = await resolverFor(record(), () => ({
      ORCA_AGENT_SESSION_ID: 'a0b1c2d3-0000-4000-8000-00000000abcd'
    }))({ identity: IDENTITY })

    expect(launch.env).toMatchObject({
      ORCA_AGENT_SESSION_ID: SESSION_ID,
      ORCA_CLI_COMMAND: expect.stringMatching(/^[^:;]*[\\/]cli[\\/]bin[\\/]orca-dev$/)
    })
    expect(launch.env?.ORCA_AGENT_SESSION_ID).not.toBe(launch.providerSessionId)
  })

  it('forces session-state events on when the inherited overlay disables them', async () => {
    const launch = await resolverFor(record(), () => ({
      [CLAUDE_SESSION_STATE_EVENTS_ENV]: '0'
    }))({ identity: IDENTITY })

    expect(launch.env).toMatchObject({ [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1' })
  })

  it('launches when only the bookkeeping leaf moved, and refuses a changed session', async () => {
    const resolve = resolverFor(RESUMABLE)

    // A failed turn-end or exit write leaves the identity's leaf behind the record's.
    await expect(resolve({ identity: identityAt('leaf-stale') })).resolves.toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: 'leaf-current'
    })
    await expect(
      resolve({
        identity: {
          ...IDENTITY,
          providerHandle: claudeProviderHandle('provider-other', 'leaf-current')
        }
      })
    ).rejects.toThrow('durable resume identity changed before spawn')
  })

  it('keeps session-only resume when the durable handle has no leaf', async () => {
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
        providerHandleChain: [
          {
            handle: claudeProviderHandle('provider-current', null)
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: identityAt(null) })

    expect(launch.options.resume).toBe('provider-current')
    expect(launch.options).not.toHaveProperty('resumeSessionAt')
  })

  it('launches a leafless head fresh under its own id when Claude never wrote its transcript', async () => {
    // A start that failed before its first turn: `--resume` would exit "No conversation found".
    const hasTranscript = vi.fn(async () => false)
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle.
        providerHandleChain: [
          { handle: claudeProviderHandle('provider-current', null) }
        ] as AgentSessionRecord['providerHandleChain']
      }),
      undefined,
      false,
      { claude: '' },
      hasTranscript
    )({ identity: identityAt(null) })

    expect(hasTranscript).toHaveBeenCalledWith({
      providerSessionId: 'provider-current',
      claudeConfigDir: expect.any(String)
    })
    expect(launch.options.resume).toBeUndefined()
    expect(launch.options.sessionId).toBe('provider-current')
    expect(launch).toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: null,
      resumesTranscript: false,
      // Launching the id fresh does not start a new conversation: the child continues the chain.
      continuesChain: true
    })
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

  it('builds on the supplied inherited env instead of Orca process env', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', SHELL_ONLY_MARKER: 'from-shell' })
    })({ identity: IDENTITY })

    expect(launch.env?.SHELL_ONLY_MARKER).toBe('from-shell')
  })

  it('drops an inherited CLAUDE_CONFIG_DIR so the record stays the only Claude home the pin sees', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveInheritedEnv: async () => ({
        PATH: '/shell/bin',
        CLAUDE_CONFIG_DIR: '/shell/claude',
        SHELL_ONLY_MARKER: 'from-shell'
      })
    })({ identity: IDENTITY })

    expect(launch.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(launch.env?.SHELL_ONLY_MARKER).toBe('from-shell')
    expect(launch.claudeConfigDir).toBe('/home/work/.claude')
  })

  it('keeps a configured overlay CLAUDE_CONFIG_DIR over the dropped inherited one', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({ CLAUDE_CONFIG_DIR: '/accounts/selected/home' }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', CLAUDE_CONFIG_DIR: '/shell/claude' })
    })({ identity: IDENTITY })

    expect(launch.env?.CLAUDE_CONFIG_DIR).toBe('/accounts/selected/home')
  })

  it('still strips an inherited auth key under a managed account', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', ANTHROPIC_API_KEY: 'listed-key' })
    })({ identity: IDENTITY })

    expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
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
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
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
        store: { getRecord: () => RESUMABLE, pinLaunchDirectory: vi.fn() },
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

      // Reacquire after the account state changed: refused before anything spawns, naming the
      // account shape a person can change.
      const refused = resolve({ identity: identityAt('leaf-current') })
      await expect(refused).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
      await expect(refused).rejects.toMatchObject({ reason: 'managedAccountUnsupported' })
    })

    it('fails closed when the account state cannot be read, naming no situation', async () => {
      const refused = resolverWithGate(() => null)({ identity: identityAt('leaf-current') })
      await expect(refused).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
      await expect(refused).rejects.toMatchObject({ reason: undefined })
    })

    it('keeps resolving when no gate is wired, so other embedders are unaffected', async () => {
      await expect(
        resolverFor(RESUMABLE)({ identity: identityAt('leaf-current') })
      ).resolves.toMatchObject({ providerSessionId: 'provider-current' })
    })
  })
})

describe('readable Claude thinking', () => {
  const launchWith = (
    thinkingDisplay?: ClaudeStructuredLaunchResolverDeps['thinkingDisplay'],
    authSwitchSettleTimeoutMs?: number,
    command = '/usr/local/bin/claude'
  ) =>
    createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => command,
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({ PROJECT_SHIM: '1', ANTHROPIC_API_KEY: 'sk-user' }),
      hasTranscript: async () => false,
      ...(thinkingDisplay ? { thinkingDisplay } : {}),
      ...(authSwitchSettleTimeoutMs === undefined ? {} : { authSwitchSettleTimeoutMs })
    })({ identity: IDENTITY })

  // Whether the CLI's directory holds a `node` decides if the runtime pairing puts that directory
  // first on PATH (Linux CI's /usr/local/bin does, a Mac's usually does not), so both are pinned.
  it.each([
    ['without a sibling Node runtime', false],
    ['with a sibling Node runtime', true]
  ])(
    'probes the CLI the launch runs, on its PATH and shims, without its credentials (%s)',
    async (_, sibling) => {
      const argsFor = vi.fn(
        async (_launch: { command: string; cwd: string; env: Record<string, string> }) => ({
          'thinking-display': 'summarized'
        })
      )
      const binDir = join(mkdtempSync(join(tmpdir(), 'orca-claude-probe-')), 'bin')
      const command = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
      makeExecutable(command)
      if (sibling) {
        makeExecutable(join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node'))
      }
      const launch = await launchWith({ argsFor }, undefined, command)
      const asked = argsFor.mock.calls[0]?.[0]
      expect(asked).toMatchObject({ command, cwd: '/repos/workspace-1' })
      const segments = (env: Record<string, string> | undefined) =>
        (env?.PATH ?? env?.Path ?? '').split(delimiter)
      // The launch's PATH is the probe's plus Orca's own CLI directory, which holds no `claude` or
      // runtime, so both resolve the same binary and the same shims in the same order.
      const orcaCliDir = launch.env?.ORCA_CLI_COMMAND ? dirname(launch.env.ORCA_CLI_COMMAND) : null
      expect(segments(launch.env).filter((dir) => dir !== orcaCliDir)).toEqual(segments(asked?.env))
      expect(segments(asked?.env)[0] === binDir).toBe(sibling)
      expect(asked?.env).toMatchObject({ PROJECT_SHIM: '1' })
      expect(asked?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      // The launch keeps the credential the user gave it.
      expect(launch.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-user' })
      expect(launch.options.extraArgs).toEqual({
        'replay-user-messages': null,
        'thinking-display': 'summarized'
      })
      expect(launch.options).not.toHaveProperty('thinking')
    }
  )

  it('passes nothing when the CLI is not known to take the flag, or nothing can say', async () => {
    const launch = await launchWith({ argsFor: async () => ({}) })
    expect(launch.options.extraArgs).toEqual({ 'replay-user-messages': null })
    expect((await launchWith()).options.extraArgs).toEqual({ 'replay-user-messages': null })
  })

  it('still rechecks an account switch that began while the probe ran', async () => {
    try {
      const launch = launchWith(
        {
          argsFor: async () => {
            beginClaudeAuthSwitch()
            return {}
          }
        },
        10
      )
      await expect(launch).rejects.toMatchObject({ reason: 'accountSwitchInProgress' })
    } finally {
      endClaudeAuthSwitch()
    }
  })
})
