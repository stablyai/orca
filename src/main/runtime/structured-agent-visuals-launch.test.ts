import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import type { NativeChatVisualsLaunch } from '../native-chat/conversation-files/native-chat-visuals-delivery'
import {
  createAcpStructuredLaunchResolver,
  createPiRpcLaunchResolver
} from './agent-session/launch/structured-agent-launch-composition.test-support'

const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/chat-scratch/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}
// The delivery joins this path, so Windows spells it with backslashes.
const SKILL_FILE = join('/app/native-chat-visuals/skills', 'orca-chat-visuals', 'SKILL.md')

let dataDirectory = ''
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'visuals-launch-'))
})
afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true })
})

const identity = (agent: string) => ({
  sessionId: `session-${agent}`,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent,
  providerHandle: null
})

function sources(
  agent: string,
  accountHome: AgentSessionRecord['accountHome'],
  visuals: NativeChatVisualsLaunch | null = VISUALS
) {
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: agent,
    providerHandleChain: [],
    accountHome
  }
  return {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/home/user/project',
    resolveEnvironment: async () => ({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ORCA_CHAT_SCRATCH_DIR: '/state/chat-scratch/another-chat'
    }),
    resolveCommand: (command: string) => `/resolved/${command}`,
    inheritedEnv: {},
    dataDirectory,
    savedSession: { hasProviderTurn: async () => false },
    prepareVisuals: async () => visuals
  }
}

function acpLaunch(agent: string, accountHome: AgentSessionRecord['accountHome'], version: string) {
  return createAcpStructuredLaunchResolver(acpLaunchSpecFor(agent)!, {
    ...sources(agent, accountHome),
    probeVersion: async () => ({ version })
  })({ identity: identity(agent) })
}

function piLaunch(visuals: NativeChatVisualsLaunch | null) {
  return createPiRpcLaunchResolver({
    ...sources('pi', { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.pi/agent' }, visuals),
    probeVersion: async () => ({ version: '1.5.0' }),
    ensureBackgroundWorkBridge: async () => null
  })(identity('pi'))
}

describe('inline visuals in every native chat agent', () => {
  it("loads the skill as Pi's own and gives it this chat's folder", async () => {
    const launch = await piLaunch(VISUALS)
    expect(launch.skillDirs).toEqual(['/app/native-chat-visuals/skills'])
    expect(launch.env.ORCA_CHAT_SCRATCH_DIR).toBe('/state/chat-scratch/abc')
    expect(launch.envToDelete).not.toContain('ORCA_CHAT_SCRATCH_DIR')
  })

  it("never hands Pi another chat's folder when visuals are off", async () => {
    const launch = await piLaunch(null)
    expect(launch.skillDirs).toBeUndefined()
    expect(launch.env.ORCA_CHAT_SCRATCH_DIR).toBeUndefined()
    expect(launch.envToDelete).toContain('ORCA_CHAT_SCRATCH_DIR')
  })

  it("adds the skill to Copilot's skill folders", async () => {
    const launch = await acpLaunch(
      'copilot',
      { variable: 'COPILOT_HOME', path: '/home/user/.copilot' },
      '1.0.114'
    )
    expect(launch.env.COPILOT_SKILLS_DIRS).toBe('/app/native-chat-visuals/skills')
    expect(launch.env.ORCA_CHAT_SCRATCH_DIR).toBe('/state/chat-scratch/abc')
  })

  it('points an agent with no skill loader at the skill through its instructions, without requiring them', async () => {
    const launch = await acpLaunch(
      'antigravity',
      { variable: 'GEMINI_HOME', path: '/home/user/orca-data/antigravity-chat' },
      '1.18.35'
    )
    expect(launch.sessionMeta).toEqual({
      antigravity: { systemPrompt: { append: expect.stringContaining(SKILL_FILE) } }
    })
    expect(launch.sessionMetaOptional).toBe(true)
    expect(launch.env.ORCA_CHAT_SCRATCH_DIR).toBe('/state/chat-scratch/abc')
  })

  it("writes nothing into the chat's folder just for visuals", async () => {
    const launch = await acpLaunch(
      'cursor',
      { variable: 'CURSOR_CONFIG_DIR', path: '/home/user/.cursor' },
      '2026.11.19-f005e9d'
    )
    expect(launch.aroundNewSession).toBeUndefined()
    expect(launch.env.ORCA_CHAT_SCRATCH_DIR).toBeUndefined()
    expect(launch.envToDelete).toContain('ORCA_CHAT_SCRATCH_DIR')
  })
})
