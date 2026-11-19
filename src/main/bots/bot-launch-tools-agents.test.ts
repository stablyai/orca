import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import {
  createAcpStructuredLaunchResolver,
  createPiRpcLaunchResolver
} from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { BotLaunchTools } from './bot-launch-tools'

const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'bot-token' }) }
const SERVERS = [
  { name: 'docs', url: 'https://docs.example/mcp', credential: 'cred-docs-1' },
  { name: 'files', command: 'files-mcp', args: ['--root', '.'], env: { MODE: 'ro' } }
]
const RELAYED = 'http://127.0.0.1:4100/bot-tools/cred-docs-1/mcp'

let dataDirectory = ''
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'bot-launch-tools-agents-'))
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

const sources = (record: AgentSessionRecord) => ({
  store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
  resolveWorkspacePath: async () => '/home/user/.orca/bots/scout',
  resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
  resolveCommand: (command: string) => `/resolved/${command}`,
  dataDirectory,
  resolveToolServers: () =>
    BotLaunchTools.for(relay, { botId: 'scout', folder: '/b', agent: record.provider }, SERVERS)
})

describe("a managed session's tools and token on agents other than Claude and Codex", () => {
  it.each([
    ['grok', { variable: 'GROK_HOME', path: '/home/user/.grok' }, '1.0.70'],
    ['omp', { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' }, '17.2.9'],
    ['antigravity', { variable: 'GEMINI_HOME', path: '/home/user/ag' }, '1.5.12']
  ] as const)(
    'opens %s sessions with the tools and runs it with the token',
    async (agent, home, version) => {
      const record = {
        ...agentSessionRecordFixture(),
        provider: agent,
        providerHandleChain: [],
        accountHome: home
      }
      const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor(agent)!, {
        ...sources(record),
        savedSession: { hasProviderTurn: async () => false },
        inheritedEnv: {},
        probeVersion: async () => ({ version })
      })({ identity: identity(agent) })
      expect(launch.env.ORCA_BOT_TOOLS_TOKEN).toBe('bot-token')
      expect(launch.mcpServers).toEqual([
        {
          type: 'http',
          name: 'docs',
          url: RELAYED,
          headers: [{ name: 'authorization', value: 'Bearer bot-token' }]
        },
        {
          name: 'files',
          command: 'files-mcp',
          args: ['--root', '.'],
          env: [{ name: 'MODE', value: 'ro' }]
        }
      ])
    }
  )

  it('loads Pi with an extension that registers the tools, naming the token only by variable', async () => {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'pi',
      providerHandleChain: [],
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.pi/agent' }
    }
    const launch = await createPiRpcLaunchResolver({
      ...sources(record),
      probeVersion: async () => ({ version: '1.5.0' }),
      ensureBackgroundWorkBridge: async () => null
    })(identity('pi'))
    expect(launch.env.ORCA_BOT_TOOLS_TOKEN).toBe('bot-token')
    const extension = launch.botTools?.extension ?? ''
    expect(extension.startsWith(dataDirectory)).toBe(true)
    expect(await readFile(extension, 'utf8')).toContain('pi.registerMcpServer(name, config)')
    expect(JSON.parse(launch.botTools?.servers ?? '')).toEqual({
      docs: { url: RELAYED, headers: { authorization: 'Bearer ${ORCA_BOT_TOOLS_TOKEN}' } },
      files: { command: 'files-mcp', args: ['--root', '.'], env: { MODE: 'ro' } }
    })
  })
})
