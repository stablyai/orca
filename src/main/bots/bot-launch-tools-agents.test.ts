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
import { botToolProblems } from './bot-tools-host'
import {
  noteAcpLaunchVersion,
  observeAcpInitialize
} from '../acp/capabilities/acp-initialize-capabilities'

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

describe('bot tools in ACP and Pi launches', () => {
  it('passes the token and MCP servers through an ACP launch', async () => {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'grok',
      providerHandleChain: [],
      accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' }
    }
    const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('grok')!, {
      ...sources(record),
      savedSession: { hasProviderTurn: async () => false },
      inheritedEnv: {},
      probeVersion: async () => ({ version: '1.0.70' })
    })({ identity: identity('grok') })
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
  })

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

describe('bot tools an agent cannot take', () => {
  const home = (agent: 'pi' | 'omp') => ({
    botId: 'scout',
    agent,
    folder: '/b',
    signInFolder: '/sign-in',
    otherBotFolders: []
  })

  it('starts an older Pi without them, says so in its instructions and on the Tools rows', async () => {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'pi',
      providerHandleChain: [],
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.pi/agent' }
    }
    const launch = await createPiRpcLaunchResolver({
      ...sources(record),
      resolveInstructions: async () => 'You are Scout.',
      probeVersion: async () => ({ version: '0.98.2' }),
      ensureBackgroundWorkBridge: async () => null
    })(identity('pi'))
    expect(launch.botTools).toBeUndefined()
    const instructions = await readFile(launch.instructionsFile ?? '', 'utf8')
    expect(instructions).toContain('You are Scout.')
    expect(instructions).toContain('Your tools docs, files are off in this chat')
    expect(instructions).toContain('Pi 0.99 or later')
    const problems = await botToolProblems(home('pi'))
    expect(Object.keys(problems)).toEqual(['docs', 'files'])
    expect(problems.docs).toEqual({
      kind: 'failed',
      detail:
        'Pi 0.99 or later is needed, and this computer has Pi 0.98.2. Update Pi to turn tools on.'
    })

    await createPiRpcLaunchResolver({
      ...sources(record),
      probeVersion: async () => ({ version: '0.99.0' }),
      ensureBackgroundWorkBridge: async () => null
    })(identity('pi'))
    expect(await botToolProblems(home('pi'))).toEqual({})
  })

  it('starts an ACP agent that turned URL tools down without them, and says so', async () => {
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'omp',
      providerHandleChain: [],
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' }
    }
    noteAcpLaunchVersion('omp', '17.2.9')
    observeAcpInitialize('omp', {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: false } }
    })
    const launch = await createAcpStructuredLaunchResolver(acpLaunchSpecFor('omp')!, {
      ...sources(record),
      resolveInstructions: async () => 'You are Scout.',
      savedSession: { hasProviderTurn: async () => false },
      inheritedEnv: {},
      probeVersion: async () => ({ version: '17.2.9' })
    })({ identity: identity('omp') })
    expect(launch.mcpServers?.map((server) => server.name)).toEqual(['files'])
    const file = launch.args.find((arg) => arg.startsWith('--append-system-prompt='))
    const instructions = await readFile(file?.slice('--append-system-prompt='.length) ?? '', 'utf8')
    expect(instructions).toContain('You are Scout.')
    expect(instructions).toContain('Your tools docs are off in this chat')
    expect(await botToolProblems(home('omp'))).toEqual({
      docs: {
        kind: 'failed',
        detail: "OMP 17.2.9 doesn't take tools at a URL."
      }
    })
  })
})
