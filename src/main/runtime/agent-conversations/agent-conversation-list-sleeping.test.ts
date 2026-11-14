import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult
} from '../../../shared/runtime-worktree-contracts'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import { InProcessAgentIdentityClient } from '../../agent-hooks/identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../agent-hooks/identity/agent-identity-worker-client'
import { buildBody } from '../../agent-hooks/server/testing/server.test-fixtures'
import type * as HookServerModule from '../../agent-hooks/server/agent-hook-server'

/** The real hook server and its SQL identity store behind `agent list` and `agent show`. */
const hooks = vi.hoisted(() => {
  const state: { server: null | Record<string, (...args: never[]) => unknown> } = { server: null }
  return state
})
vi.mock('../../agent-hooks/server/agent-hook-server', async (load) => ({
  ...(await load<typeof HookServerModule>()),
  agentHookServer: new Proxy(
    {},
    {
      get:
        (_, name: string) =>
        (...args: never[]) =>
          hooks.server![name]!(...args)
    }
  )
}))

const { AgentHookServer } = await import('../../agent-hooks/server/agent-hook-server')
const { agentConversationPlaces, listAgentConversations } =
  await import('./agent-conversation-list')

const WORKTREE = 'repo::/work/delta'
const cleanups: (() => void)[] = []
afterEach(() => {
  hooks.server = null
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }

  moveStatusFile(path: string): void {
    this.setStatusFilePath(path)
  }
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-list-sleeping-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

const pane = (tab: number) => makePaneKey(`tab-${tab}`, '00000000-0000-4000-8000-000000000000')

function record(tab: number, session: string, reply: string): SleepingAgentSessionRecord {
  return {
    paneKey: pane(tab),
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: {
      key: 'session_id',
      id: session,
      transcriptPath: `/home/u/.claude/projects/p/${session}.jsonl`
    },
    prompt: 'task',
    state: 'done',
    capturedAt: 10 + tab,
    updatedAt: 10 + tab,
    lastAssistantMessage: reply,
    connectionId: null,
    origin: 'worktree-sleep'
  }
}

/** Local Claude agents that reported once, each named by the store, then put to sleep. */
async function sleptAgents(sessions: string[]) {
  const server = new IdentityTestServer()
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: directory() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy forwards only the hook server's own methods.
  hooks.server = server as unknown as Record<string, (...args: never[]) => unknown>
  const ids: OrcaSessionId[] = []
  for (const [tab, session] of sessions.entries()) {
    const event = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      buildBody(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: session,
          transcript_path: `/home/u/.claude/projects/p/${session}.jsonl`,
          prompt: 'task'
        },
        { paneKey: pane(tab), tabId: `tab-${tab}` }
      ),
      'production'
    )
    server.ingestRemote(event!, null)
    await new Promise((resolve) => setImmediate(resolve))
    const id = server.getStatusSnapshot().find((row) => row.paneKey === pane(tab))?.orcaSessionId
    if (!id || !isOrcaSessionId(id)) {
      throw new Error('the agent was not named')
    }
    ids.push(id)
    server.dropStatusEntry(pane(tab), { preserveResumeIdentity: false })
  }
  server.identityClient.idsOfKeysRequests = 0
  server.identityClient.providerKeyRequests = 0
  return { server, ids }
}

function runtime(
  records: Record<string, SleepingAgentSessionRecord>,
  agents: Partial<RuntimeWorktreeAgentRow>[] = []
) {
  const ps = {
    worktrees: [{ worktreeId: WORKTREE, displayName: 'delta', repo: 'repo', agents }],
    totalCount: 1,
    truncated: false
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing reads only each worktree's id, labels and agent rows.
    getWorktreePs: async () => ps as unknown as RuntimeWorktreePsResult,
    readLocalSleepingAgentSessions: () => records,
    getWorkspaceLabel: (worktreeId: string) =>
      worktreeId === WORKTREE ? { workspace: 'delta', repo: 'repo' } : null
  }
}

it('lists and shows a terminal agent whose workspace is asleep, without waking it', async () => {
  const { ids } = await sleptAgents(['session-a'])
  const host = runtime({ [pane(0)]: record(0, 'session-a', 'DELTA done') })

  const listed = await listAgentConversations(host, 10)
  const shown = await agentConversationPlaces(host, { kind: 'terminal', orcaSessionId: ids[0]! })

  const asleep = {
    orcaSessionId: ids[0],
    kind: 'terminal',
    agent: 'claude',
    state: 'asleep',
    worktreeId: WORKTREE,
    workspace: 'delta',
    repo: 'repo',
    paneKey: pane(0),
    lastAssistantMessage: 'DELTA done'
  }
  expect(listed.agents).toEqual([expect.objectContaining(asleep)])
  expect(shown).toEqual([expect.objectContaining(asleep)])
  expect(await listAgentConversations(host, 10, { state: 'asleep' })).toMatchObject({
    agents: [{ orcaSessionId: ids[0] }]
  })
  expect(await listAgentConversations(host, 10, { state: 'working' })).toMatchObject({
    agents: []
  })
})

it('keeps the tabs a wake has not reopened, and the woken row keeps its last reply', async () => {
  const { ids } = await sleptAgents(['session-a', 'session-b'])
  // Tab 0 woke and resumed with no new reply yet; tab 1 has not been opened since the wake.
  const host = runtime(
    {
      [pane(0)]: { ...record(0, 'session-a', 'ECHO done'), origin: 'live' },
      [pane(1)]: record(1, 'session-b', 'DELTA done')
    },
    [
      {
        paneKey: pane(0),
        orcaSessionId: ids[0],
        agentType: 'claude',
        state: 'working',
        lastAssistantMessage: null,
        conversationName: 'echo',
        updatedAt: 50
      }
    ]
  )

  const listed = await listAgentConversations(host, 10)

  expect(listed.agents).toEqual([
    expect.objectContaining({
      orcaSessionId: ids[0],
      state: 'working',
      lastAssistantMessage: 'ECHO done'
    }),
    expect.objectContaining({
      orcaSessionId: ids[1],
      state: 'asleep',
      paneKey: pane(1),
      lastAssistantMessage: 'DELTA done'
    })
  ])
})

it.each([100, 1_000])(
  'asks the store once for %i sleeping agents across repeated lists, and again for a new store',
  async (count) => {
    const { server, ids } = await sleptAgents(['session-a'])
    const records: Record<string, SleepingAgentSessionRecord> = {
      [pane(0)]: record(0, 'session-a', 'DELTA done')
    }
    for (let index = 1; index < count; index++) {
      records[`tab-x${index}:1`] = {
        ...record(0, `never-${index}`, ''),
        paneKey: `tab-x${index}:1`
      }
    }
    const host = runtime(records)

    for (let call = 0; call < 12; call++) {
      const listed = await listAgentConversations(host, 10)
      expect(listed.agents).toHaveLength(count)
      expect(listed.agents.find((row) => row.paneKey === pane(0))?.orcaSessionId).toBe(ids[0])
    }
    expect(server.identityClient.idsOfKeysRequests).toBe(1)
    expect(server.identityClient.providerKeyRequests).toBe(0)

    // Another store never linked these keys: its answer, asked once, replaces the old one.
    server.moveStatusFile(join(directory(), 'status.json'))
    const moved = await listAgentConversations(host, 10)
    expect(moved.agents.find((row) => row.paneKey === pane(0))?.orcaSessionId).toBeNull()
    expect(server.identityClient.idsOfKeysRequests).toBe(2)
  }
)
