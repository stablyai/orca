import { mkdtempSync } from 'node:fs'
import { BotLaunchTools } from '../bots/bot-launch-tools'
import type { StructuredAgentLaunchSources } from './agent-session/launch/structured-agent-launch-composition'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import type { NativeChatVisualsLaunch } from '../native-chat/conversation-files/native-chat-visuals-delivery'
import {
  createClaudeStructuredLaunchResolver,
  createCodexStructuredLaunchResolver
} from './agent-session/launch/structured-agent-launch-composition.test-support'

const VISUALS: NativeChatVisualsLaunch = {
  folder: '/state/chat-scratch/abc',
  skill: { pluginDir: '/app/native-chat-visuals', skillsRoot: '/app/native-chat-visuals/skills' }
}
const identity = (sessionId: string, agent: 'claude' | 'codex'): AgentSessionJournalIdentity => ({
  sessionId,
  workspaceId: 'workspace-1',
  hostId: LOCAL_EXECUTION_HOST_ID,
  agent,
  providerHandle: null
})
const readOnlySession = (sessionId: string) =>
  sessionId === 'look' ? 'look-around' : sessionId === 'tidy' ? 'reply-only' : null

const NOTION = { name: 'notion', url: 'https://mcp.notion.com/mcp' }

function claudeLaunch(
  sessionId: string,
  prepareLaunch?: StructuredAgentLaunchSources['prepareLaunch']
) {
  const record = agentSessionRecordFixture({ sessionId })
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveLaunchArgs: () => [],
    hasTranscript: async () => false,
    prepareVisuals: async () => VISUALS,
    readOnlySession,
    resolveToolServers: () =>
      BotLaunchTools.for(
        { grant: async () => ({ origin: '', token: '' }) },
        { botId: 'b', folder: '/b', agent: 'claude' },
        [NOTION]
      ),
    ...(prepareLaunch ? { prepareLaunch } : {})
  })({ identity: identity(sessionId, 'claude'), permissionMode: 'full-access' })
}

function codexLaunch(sessionId: string, codexHome: string) {
  const record = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: codexHome }
  })
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveCommand: () => ({ command: 'codex', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    prepareVisuals: async () => VISUALS,
    readOnlySession,
    resolveToolServers: () =>
      BotLaunchTools.for(
        { grant: async () => ({ origin: '', token: '' }) },
        { botId: 'b', folder: '/b', agent: 'claude' },
        [NOTION]
      )
  })({ identity: identity(sessionId, 'codex'), spawnToken: 'token', permissionMode: 'full-access' })
}

describe('every launch, Look around included', () => {
  it('waits for the launch preparation, and a failed one stops it', async () => {
    for (const sessionId of ['look', 'chat']) {
      const prepared = Promise.withResolvers<void>()
      let asked = false
      let resolved = false
      const launch = claudeLaunch(sessionId, () => {
        asked = true
        return prepared.promise
      }).then(() => (resolved = true))
      await vi.waitFor(() => expect(asked).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(resolved).toBe(false)
      prepared.resolve()
      await launch
      expect(resolved).toBe(true)
      await expect(
        claudeLaunch(sessionId, () => Promise.reject(new Error('cleanup failed')))
      ).rejects.toThrow('cleanup failed')
    }
  })
})

describe('a read-only (look-around) launch', () => {
  it("runs Claude on Orca's tool hook in Ask, with no visuals, whatever the chat chose", async () => {
    const look = await claudeLaunch('look')
    expect(look.options.hooks?.PreToolUse).toHaveLength(1)
    expect(look.options.disallowedTools).toEqual(expect.arrayContaining(['Write', 'WebFetch']))
    expect(look.options.permissionMode).toBe('default')
    expect(look.options.extraArgs).not.toHaveProperty('dangerously-skip-permissions')
    expect(look.options.plugins).toBeUndefined()
    // A bot's own servers are never started for a look.
    expect(look.options.mcpServers).toBeUndefined()

    const chat = await claudeLaunch('chat')
    expect(chat.options.hooks).toBeUndefined()
    expect(chat.options.extraArgs).toHaveProperty('dangerously-skip-permissions')
    expect(chat.options.mcpServers).toEqual({ notion: { type: 'http', url: NOTION.url } })
  })

  // Its MCP servers are turned off once the app-server reads its config (codexReadOnlyMcpOff).
  it('runs Codex in Ask with its plugins and web search off', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-read-only-launch-'))
    const look = await codexLaunch('look', home)
    expect(look.readOnly).toBe('look-around')
    expect(look.permissionPolicy).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'read-only'
    })
    expect(look.threadConfig).toMatchObject({
      'features.plugins': false,
      web_search: 'disabled'
    })
    expect(look.visuals).toBeUndefined()

    // A bot's own tools are added to its chats, never to a look.
    expect(look.threadConfig).not.toHaveProperty('mcp_servers.notion.url')

    const chat = await codexLaunch('chat', home)
    expect(chat.readOnly).toBeUndefined()
    expect(chat.threadConfig).toEqual({ 'mcp_servers.notion.url': NOTION.url })
    expect(chat.permissionPolicy).toMatchObject({ sandbox: 'danger-full-access' })
  })

  it('gives a tidy-up no tools, MCP servers or configured hooks in either agent', async () => {
    const claude = await claudeLaunch('tidy')
    expect(claude.options).toMatchObject({
      tools: [],
      strictMcpConfig: true,
      settings: { disableAllHooks: true }
    })
    expect(claude.options.mcpServers).toBeUndefined()

    const home = mkdtempSync(join(tmpdir(), 'orca-read-only-launch-'))
    const codex = await codexLaunch('tidy', home)
    expect(codex.readOnly).toBe('reply-only')
    expect(codex.threadConfig).toMatchObject({
      'features.hooks': false,
      'features.shell_tool': false,
      'features.unified_exec': false
    })
  })
})
