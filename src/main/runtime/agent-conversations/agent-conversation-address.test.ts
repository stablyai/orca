import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentConversation } from './agent-conversation-address'

const hookServer = vi.hoisted(() => ({
  isTerminalAgentId: vi.fn<(id: string) => Promise<boolean | undefined>>(),
  terminalAgentIdsOfProviderSession: vi.fn<(id: string) => Promise<string[]>>()
}))
const chats = vi.hoisted(() => ({ ids: new Set<string>(), aliases: new Map<string, string>() }))

vi.mock('../../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: hookServer }))
vi.mock('../orchestration/addressing/session-lineage/structured-session-lineage', async (load) => ({
  ...(await load<object>()),
  readAgentSessionRecordStore: () => ({
    getRecord: (id: string) =>
      chats.ids.has(id) ? { sessionId: id, provider: 'codex', providerHandleChain: [] } : null,
    listRecords: () => [],
    providerAliasOwner: (id: string) => chats.aliases.get(id) ?? null
  })
}))

const CHAT = 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47'
const TERMINAL = 'claude_5688af50_12a0_4b0b_9a4a_098d87fe1e68'
const runtime = { ensureStructuredAgentSessionHost: async () => undefined }

beforeEach(() => {
  chats.ids = new Set([CHAT])
  chats.aliases = new Map()
  hookServer.isTerminalAgentId.mockReset().mockResolvedValue(false)
  hookServer.terminalAgentIdsOfProviderSession.mockReset().mockResolvedValue([])
})

describe('resolveAgentConversation', () => {
  it('resolves a chat from the chat store alone, without the terminal identity store', async () => {
    await expect(
      resolveAgentConversation(runtime, ` orca_session_id:${CHAT}\n`)
    ).resolves.toMatchObject({ kind: 'chat', orcaSessionId: CHAT })
    expect(hookServer.isTerminalAgentId).not.toHaveBeenCalled()
  })

  it('names the Orca ID for a terminal provider id before refusing its spelling', async () => {
    hookServer.terminalAgentIdsOfProviderSession.mockResolvedValue([TERMINAL])
    await expect(
      resolveAgentConversation(runtime, '7f201ef0-437e-44d9-94da-6323eee9a3f4')
    ).rejects.toMatchObject({
      code: 'agent_provider_id',
      message: expect.stringContaining(`orca_session_id:${TERMINAL}`)
    })
  })

  it('refuses a terminal handle, and an ID no store on this host knows', async () => {
    await expect(resolveAgentConversation(runtime, 'term_0a1b2c')).rejects.toMatchObject({
      code: 'agent_terminal_handle'
    })
    await expect(resolveAgentConversation(runtime, TERMINAL)).rejects.toMatchObject({
      code: 'agent_unknown'
    })
    hookServer.isTerminalAgentId.mockResolvedValue(true)
    await expect(resolveAgentConversation(runtime, TERMINAL)).resolves.toEqual({
      kind: 'terminal',
      orcaSessionId: TERMINAL
    })
  })
})
