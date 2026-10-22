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

const COPILOT = acpLaunchSpecFor('copilot')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'copilot',
  providerHandle: null
}

function copilotRecord(
  accountHome: AgentSessionRecord['accountHome'] = {
    variable: 'COPILOT_HOME',
    path: '/home/user/.copilot'
  }
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'copilot',
    providerHandleChain: [],
    accountHome
  }
}

function resolver(
  record: AgentSessionRecord,
  options: {
    launchEnv?: Record<string, string>
    probeVersion?: Parameters<typeof createAcpStructuredLaunchResolver>[1]['probeVersion']
  } = {}
) {
  return createAcpStructuredLaunchResolver(COPILOT, {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/repo/worktree',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    probeVersion: options.probeVersion ?? (async (_input, supports) => supports('1.0.98'))
  })
}

describe('Copilot ACP launch resolution', () => {
  it('runs `copilot --acp --stdio` under the account home the chat pinned, with or without full access', async () => {
    for (const fullAccess of [false, true]) {
      const launch = await resolver(copilotRecord())({
        identity,
        spawnToken: 'token',
        permissionMode: fullAccess ? 'full-access' : 'ask'
      })
      expect(launch).toMatchObject({
        command: '/resolved/copilot',
        args: ['--acp', '--stdio'],
        fullAccess
      })
      expect(launch.args).not.toContain('--yolo')
      expect(launch.env.COPILOT_HOME).toBe('/home/user/.copilot')
      expect(launch.env.COPILOT_ALLOW_ALL).toBe('false')
    }
  })

  it("keeps the user's credentials but forces the inherited allow-all switch off", async () => {
    const userEnv = {
      COPILOT_GITHUB_TOKEN: 'copilot-token',
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      COPILOT_MODEL: 'gpt-6-luna'
    }
    const launch = await resolver(copilotRecord(), {
      launchEnv: { ...userEnv, COPILOT_ALLOW_ALL: 'true' }
    })({ identity })
    // Only the shared pane and hook keys, and inherited scratch folders: this chat has none.
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
    // The inherited switch must not turn a chat in Ask mode into full access.
    expect(child.COPILOT_ALLOW_ALL).toBe('false')
    // A pane's identity would let Copilot's Orca hook report for this chat too.
    expect(child.ORCA_PANE_KEY).toBeUndefined()
  })

  it('keeps a chat on the account home it pinned when the launch env names another', async () => {
    const launch = await resolver(copilotRecord(), {
      launchEnv: { COPILOT_HOME: '/data/other-copilot' }
    })({ identity })
    expect(launch.env.COPILOT_HOME).toBe('/home/user/.copilot')
  })

  it("refuses a record that pins another agent's directory", async () => {
    await expect(
      resolver(copilotRecord({ variable: 'GROK_HOME', path: '/home/user/.grok' }))({ identity })
    ).rejects.toThrow(/pin COPILOT_HOME/)
  })

  it.each(['1.0.98', '1.0.99', '1.4.0', '2.0.0'])('admits Copilot %s', async (version) => {
    const launch = resolver(copilotRecord(), {
      probeVersion: async (_input, supports) => supports(version)
    })
    await expect(launch({ identity })).resolves.toMatchObject({ args: ['--acp', '--stdio'] })
  })

  it.each(['1.0.97', '0.9.0', '2.0.0-beta.1'])(
    'refuses Copilot %s before spawning it, as a host that cannot run the chat',
    async (version) => {
      const launch = resolver(copilotRecord(), {
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
    const launch = resolver(copilotRecord(), { probeVersion: async () => false })
    await expect(launch({ identity })).rejects.toMatchObject({
      refusal: { code: 'structured_agent_session_unsupported' }
    })
  })

  it('re-probes at every launch, so a release a PATH change swapped in refuses without falling back', async () => {
    let installed = '1.0.98'
    const launch = resolver(copilotRecord(), {
      probeVersion: async (_input, supports) => supports(installed)
    })
    await expect(launch({ identity })).resolves.toMatchObject({ command: '/resolved/copilot' })
    installed = '1.0.96'
    await expect(launch({ identity })).rejects.toMatchObject({
      refusal: {
        code: 'structured_agent_session_unsupported',
        details: { reason: 'hostUnsupported' }
      }
    })
  })

  it('asks the version of exactly the binary, folder and environment it spawns', async () => {
    const asked: Parameters<
      NonNullable<Parameters<typeof createAcpStructuredLaunchResolver>[1]['probeVersion']>
    >[0][] = []
    const launch = await resolver(copilotRecord(), {
      probeVersion: async (input, supports) => (asked.push(input), supports('1.0.98'))
    })({ identity })
    expect(asked).toEqual([{ program: launch.command, cwd: launch.cwd, env: launch.env }])
  })
})
