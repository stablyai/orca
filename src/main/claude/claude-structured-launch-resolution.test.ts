import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeStructuredAuthPolicyForSettings } from '../claude-accounts/claude-structured-auth-policy'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeSdkOptionsForLaunchArgs,
  claudeSessionIdForOrcaSession,
  createClaudeStructuredLaunchResolver
} from './claude-structured-launch-resolution'

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
  stripAuthEnv = false
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    resolveAuthPolicy: () => ({ stripAuthEnv }),
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
  providerHandleChain: [
    { handle: { provider: 'claude', sessionId: 'provider-current', leafUuid: 'leaf-current' } }
  ] as AgentSessionRecord['providerHandleChain']
})

describe('claude structured launch resolution', () => {
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

  it('preserves durable Claude launch arguments as typed options and extraArgs', async () => {
    const launch = await resolverFor(
      record({
        launchArgs: [
          '--model',
          'claude-sonnet-4-5',
          '--effort',
          'high',
          '--dangerously-skip-permissions'
        ]
      })
    )({ identity: IDENTITY })

    expect(launch.options.model).toBe('claude-sonnet-4-5')
    expect(launch.options.effort).toBe('high')
    expect(launch.options.extraArgs).toEqual({
      'dangerously-skip-permissions': null,
      'replay-user-messages': null
    })
  })

  it('routes durable launch arguments to a typed option first and refuses what neither can carry', () => {
    // The catalog's own output: each flag lands in exactly one place, so the SDK
    // cannot emit it twice with two different values.
    expect(claudeSdkOptionsForLaunchArgs(['--model', 'opus', '--effort', 'xhigh'])).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
    // An effort the SDK's union does not name still reaches the CLI, unchanged.
    expect(claudeSdkOptionsForLaunchArgs(['--effort', 'ultra'])).toEqual({
      extraArgs: { effort: 'ultra' }
    })
    expect(claudeSdkOptionsForLaunchArgs(['--settings=/tmp/s.json'])).toEqual({
      extraArgs: { settings: '/tmp/s.json' }
    })
    expect(() => claudeSdkOptionsForLaunchArgs(['-m', 'opus'])).toThrow(/no SDK option/)
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
  })
})
