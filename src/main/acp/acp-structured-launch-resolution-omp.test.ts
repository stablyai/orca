import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import {
  createAcpStructuredLaunchResolver,
  type AcpStructuredLaunchResolverDeps
} from './acp-structured-launch-resolution'

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
    fullAccess?: boolean
    probeVersion?: AcpStructuredLaunchResolverDeps['probeVersion']
  } = {}
) {
  return createAcpStructuredLaunchResolver(OMP, {
    store: { getRecord: () => record },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveFullAccess: () => options.fullAccess ?? false,
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    probeVersion: options.probeVersion ?? (async (_input, supports) => supports('17.0.5'))
  })
}

describe('OMP ACP launch resolution', () => {
  it('runs `omp acp` pointed at the agent directory the chat pinned, with or without full access', async () => {
    for (const fullAccess of [false, true]) {
      const launch = await resolver(ompRecord(), { fullAccess })({ identity })
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
    expect(launch.envToDelete).toEqual([])
    const child = createProviderSpawnSpec(
      {
        command: launch.command,
        args: launch.args,
        env: launch.env,
        envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
      },
      { ORCA_PANE_KEY: 'tab-1:pane-1' },
      'darwin'
    ).env
    expect(child).toMatchObject(userEnv)
    // A pane's identity would let OMP's Orca status extension report for this chat too.
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

  it.each(['17.0.5', '17.2.12', '18.4.5'])('admits OMP %s', async (version) => {
    const launch = resolver(ompRecord(), {
      probeVersion: async (_input, supports) => supports(version)
    })
    await expect(launch({ identity })).resolves.toMatchObject({ args: ['acp'] })
  })

  it.each(['17.0.4', '16.9.0', '18.0.0-beta.1'])(
    'refuses OMP %s before spawning it, as a host that cannot run the chat',
    async (version) => {
      const launch = resolver(ompRecord(), {
        probeVersion: async (_input, supports) => supports(version)
      })
      await expect(launch({ identity })).rejects.toMatchObject({
        refusal: {
          code: 'structured_agent_session_unsupported',
          details: { reason: 'hostUnsupported' }
        }
      })
    }
  )

  it('refuses when the version cannot be read', async () => {
    const launch = resolver(ompRecord(), { probeVersion: async () => false })
    await expect(launch({ identity })).rejects.toMatchObject({
      refusal: { code: 'structured_agent_session_unsupported' }
    })
  })

  it('asks the version of exactly the binary, folder and environment it spawns', async () => {
    const asked: Parameters<NonNullable<AcpStructuredLaunchResolverDeps['probeVersion']>>[0][] = []
    const launch = await resolver(ompRecord(), {
      probeVersion: async (input, supports) => (asked.push(input), supports('17.0.5'))
    })({ identity })
    expect(asked).toEqual([{ program: launch.command, cwd: launch.cwd, env: launch.env }])
  })
})
