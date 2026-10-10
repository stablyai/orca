import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { ManagedDataAccountsState } from '../../shared/managed-account-types'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { scrubOpenCodeAcpEnvironment } from '../opencode/opencode-acp-environment'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import {
  createAcpStructuredLaunchResolver,
  type AcpStructuredLaunchResolverDeps
} from './acp-structured-launch-resolution'

const PROFILE = '123e4567-e89b-42d3-a456-426614174000'

const managedAccounts = {
  list: (): ManagedDataAccountsState => ({
    accounts: [{ id: PROFILE, label: 'work', integrations: [], createdAt: 0 }],
    activeAccountId: PROFILE
  }),
  restoreOriginalEnvironment: (environment: Record<string, string | undefined>) =>
    restoreManagedDataAccountEnvironment(environment),
  environmentForAccount: (_provider: 'opencode' | 'devin', id: string) => ({
    XDG_DATA_HOME: `/profiles/${id}/data`,
    XDG_STATE_HOME: `/profiles/${id}/state`,
    OPENCODE_DB: 'opencode.db',
    OPENCODE_AUTH_CONTENT: ''
  })
}

const OPENCODE = {
  ...acpLaunchSpecFor('opencode')!,
  account: openCodeAcpAccountBinding(() => managedAccounts)
}
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'opencode',
  providerHandle: null
}

function openCodeRecord(accountHome: AgentSessionRecord['accountHome']): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'opencode',
    providerHandleChain: [],
    accountHome
  }
}

const UNMANAGED: AgentSessionRecord['accountHome'] = {
  kind: 'opencode',
  locator: { kind: 'unmanaged' }
}

function resolver(
  record: AgentSessionRecord,
  options: {
    launchEnv?: Record<string, string>
    inheritedEnv?: NodeJS.ProcessEnv
    base?: Record<string, string>
    probeVersion?: AcpStructuredLaunchResolverDeps['probeVersion']
  } = {}
) {
  return createAcpStructuredLaunchResolver(OPENCODE, {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user', ...options.base }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: options.inheritedEnv ?? {},
    probeVersion: options.probeVersion ?? (async (_input, supports) => supports('1.18.31'))
  })
}

describe('OpenCode ACP launch resolution', () => {
  it('runs `opencode acp` as an ACP client with no question tool, whatever the user set', async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      launchEnv: { OPENCODE_CLIENT: 'tui', OPENCODE_ENABLE_QUESTION_TOOL: 'true' }
    })({ identity })
    expect(launch).toMatchObject({ command: '/resolved/opencode', args: ['acp'] })
    expect(launch.env).toMatchObject({
      OPENCODE_CLIENT: 'acp',
      OPENCODE_ENABLE_QUESTION_TOOL: 'false'
    })
  })

  it("starts OpenCode with the user's own folders, database and inline credentials", async () => {
    const userEnv = {
      HOME: 'relative/home',
      XDG_DATA_HOME: 'relative/data',
      XDG_STATE_HOME: '/data/opencode-state',
      OPENCODE_DB: 'work.db',
      OPENCODE_AUTH_CONTENT: '{"secret":1}'
    }
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      base: { XDG_DATA_HOME: '/elsewhere' },
      launchEnv: userEnv
    })({ identity })
    expect(launch.env).toMatchObject(userEnv)
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      {},
      'darwin'
    ).env
    expect(child).toMatchObject(userEnv)
  })

  it('leaves unset what the user left unset, whatever Orca itself inherited', async () => {
    const inheritedEnv = { OPENCODE_DB: '/elsewhere/other.db', OPENCODE_AUTH_CONTENT: '' }
    const launch = await resolver(openCodeRecord(UNMANAGED), { inheritedEnv })({ identity })
    expect(launch.env.XDG_DATA_HOME).toBeUndefined()
    expect(launch.env.OPENCODE_DB).toBeUndefined()
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      inheritedEnv,
      'darwin'
    ).env
    expect(child.OPENCODE_DB).toBeUndefined()
    expect(child.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })

  it('points a managed profile at its own directories', async () => {
    const launch = await resolver(
      openCodeRecord({ kind: 'opencode', locator: { kind: 'managed', managedProfileId: PROFILE } })
    )({ identity })
    expect(launch.env).toMatchObject({
      XDG_DATA_HOME: `/profiles/${PROFILE}/data`,
      XDG_STATE_HOME: `/profiles/${PROFILE}/state`,
      OPENCODE_DB: 'opencode.db',
      OPENCODE_AUTH_CONTENT: ''
    })
  })

  it("restores the user's own config directory over Orca's status overlay", async () => {
    const inheritedEnv = {
      OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/home/user/.config/opencode-mine',
      ORCA_OPENCODE_AGENT: 'opencode'
    }
    const launch = await resolver(openCodeRecord(UNMANAGED), { inheritedEnv })({ identity })
    expect(launch.env.OPENCODE_CONFIG_DIR).toBe('/home/user/.config/opencode-mine')
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      inheritedEnv,
      'darwin'
    ).env
    expect(Object.keys(child).filter((key) => key.startsWith('ORCA_OPENCODE_'))).toEqual([])
    expect(child.OPENCODE_CONFIG_DIR).toBe('/home/user/.config/opencode-mine')
  })

  it('drops an inherited overlay with no recorded source, so the default config is read', async () => {
    const inheritedEnv = {
      OPENCODE_CONFIG_DIR: '/orca/overlay',
      ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay'
    }
    const launch = await resolver(openCodeRecord(UNMANAGED), { inheritedEnv })({ identity })
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      inheritedEnv,
      'darwin'
    ).env
    expect(child.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(child.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
  })

  it("drops Orca's retired shared plugin directory an old shell still exports", () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_DIR: '/orca-data/opencode-hooks/shared',
      ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
    }
    const removed = scrubOpenCodeAcpEnvironment(env, {}, '/orca-data')
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(removed).toEqual(
      expect.arrayContaining(['OPENCODE_CONFIG_DIR', 'ORCA_DATA_ACCOUNT_PROVIDER'])
    )
  })

  it("keeps a config directory the user set for OpenCode's launches", async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      launchEnv: { OPENCODE_CONFIG_DIR: '/home/user/team-config' },
      inheritedEnv: {
        OPENCODE_CONFIG_DIR: '/orca/overlay',
        ORCA_OPENCODE_CONFIG_DIR: '/orca/overlay'
      }
    })({ identity })
    expect(launch.env.OPENCODE_CONFIG_DIR).toBe('/home/user/team-config')
    expect(launch.envToDelete).not.toContain('OPENCODE_CONFIG_DIR')
  })

  it('refuses a record that pins a single directory instead of an OpenCode account', async () => {
    await expect(
      resolver(openCodeRecord({ variable: 'XDG_DATA_HOME', path: '/data' }))({ identity })
    ).rejects.toThrow(/pinned data account/)
  })

  it('runs an `opencode` that is stable 2.x', async () => {
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      probeVersion: async (_input, supports) => supports('2.0.21')
    })({ identity })
    expect(launch.args).toEqual(['acp'])
  })

  it('refuses a release outside its lines before spawning it, as a host that cannot run the chat', async () => {
    const launch = resolver(openCodeRecord(UNMANAGED), {
      probeVersion: async (_input, supports) => supports('3.0.0')
    })({ identity })
    await expect(launch).rejects.toMatchObject({
      refusal: {
        code: 'structured_agent_session_unsupported',
        details: { reason: 'hostUnsupported' }
      }
    })
  })

  it('refuses when the version cannot be read', async () => {
    const launch = resolver(openCodeRecord(UNMANAGED), { probeVersion: async () => false })
    await expect(launch({ identity })).rejects.toMatchObject({
      refusal: { code: 'structured_agent_session_unsupported' }
    })
  })

  it('asks the version of exactly the binary, folder and environment it spawns', async () => {
    const asked: Parameters<NonNullable<AcpStructuredLaunchResolverDeps['probeVersion']>>[0][] = []
    const launch = await resolver(openCodeRecord(UNMANAGED), {
      probeVersion: async (input, supports) => (asked.push(input), supports('1.18.31'))
    })({ identity })
    expect(asked).toEqual([{ program: launch.command, cwd: launch.cwd, env: launch.env }])
  })
})
