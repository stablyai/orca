import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'

const OMP = acpLaunchSpecFor('omp')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'omp',
  providerHandle: null
}

function ompRecord(
  accountHome: AgentSessionRecord['accountHome'] = {
    variable: 'PI_CODING_AGENT_DIR',
    path: '/home/user/.omp/agent'
  }
): AgentSessionRecord {
  return { ...agentSessionRecordFixture(), provider: 'omp', providerHandleChain: [], accountHome }
}

function resolver(
  record: AgentSessionRecord,
  options: {
    launchEnv?: Record<string, string>
    probeVersion?: Parameters<typeof createAcpStructuredLaunchResolver>[1]['probeVersion']
  } = {}
) {
  return createAcpStructuredLaunchResolver(OMP, {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    probeVersion: options.probeVersion ?? (async () => ({ version: '17.0.5' }))
  })
}

describe('OMP ACP launch resolution', () => {
  it("runs `omp acp` pointed at the agent directory the chat pinned, in the chat's own mode", async () => {
    for (const permissionMode of ['ask', 'full-access'] as const) {
      const launch = await resolver(ompRecord())({ identity, spawnToken: 'token', permissionMode })
      const fullAccess = permissionMode === 'full-access'
      expect(launch).toMatchObject({ command: '/resolved/omp', args: ['acp'], fullAccess })
      expect(launch.env.PI_CODING_AGENT_DIR).toBe('/home/user/.omp/agent')
    }
  })

  it("passes the user's own OMP environment through unchanged", async () => {
    const userEnv = {
      OMP_PROFILE: 'work',
      PI_CONFIG_DIR: 'relative/config',
      PI_SMOL_MODEL: 'fast',
      ANTHROPIC_API_KEY: 'sk-test'
    }
    const launch = await resolver(ompRecord(), { launchEnv: userEnv })({ identity })
    expect(launch.envToDelete).toEqual([
      ...STRUCTURED_CHILD_ENV_TO_DELETE,
      NATIVE_CHAT_SCRATCH_DIR_ENV,
      LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
    ])
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...STRUCTURED_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      { ORCA_PANE_KEY: 'tab-1:pane-1' },
      'darwin'
    ).env
    expect(child).toMatchObject(userEnv)
    // Pane identity would let the terminal extension report status for this chat.
    expect(child.ORCA_PANE_KEY).toBeUndefined()
  })

  it('keeps a chat on the directory it pinned when the launch env names another', async () => {
    const launch = await resolver(ompRecord(), {
      launchEnv: { PI_CODING_AGENT_DIR: '/data/other-agent' }
    })({ identity })
    expect(launch.env.PI_CODING_AGENT_DIR).toBe('/home/user/.omp/agent')
  })

  it("refuses a record that pins another agent's directory", async () => {
    await expect(
      resolver(ompRecord({ variable: 'GROK_HOME', path: '/home/user/.grok' }))({ identity })
    ).rejects.toThrow(/pin PI_CODING_AGENT_DIR/)
  })

  it.each(['17.0.5', '17.2.12', '18.4.5', '18.0.0-beta.1'])('admits OMP %s', async (version) => {
    const launch = resolver(ompRecord(), { probeVersion: async () => ({ version }) })
    await expect(launch({ identity })).resolves.toMatchObject({ args: ['acp'] })
  })

  it.each(['17.0.4', '16.9.0'])('refuses OMP %s before spawning it as too old', async (version) => {
    const launch = resolver(ompRecord(), { probeVersion: async () => ({ version }) })
    await expect(launch({ identity })).rejects.toMatchObject({
      installation: { agent: 'omp', installedVersion: version, minimumVersion: '17.0.5' }
    })
  })

  it('asks the version of exactly the binary, folder and environment it spawns', async () => {
    const asked: Parameters<
      NonNullable<Parameters<typeof createAcpStructuredLaunchResolver>[1]['probeVersion']>
    >[0][] = []
    const launch = await resolver(ompRecord(), {
      probeVersion: async (input) => (asked.push(input), { version: '17.0.5' })
    })({ identity })
    expect(asked).toEqual([
      { program: launch.command, prefixArgs: launch.prefixArgs, cwd: launch.cwd, env: launch.env }
    ])
  })
})
