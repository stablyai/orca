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
const { listAgentConversations } = await import('./agent-conversation-list')

const WORKTREE = 'repo::/work/delta'
const OTHER = 'repo::/work/echo'
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

  moveStatusFile(path: string | null): void {
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

async function started(): Promise<IdentityTestServer> {
  const server = new IdentityTestServer()
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: directory() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy forwards only the hook server's own methods.
  hooks.server = server as unknown as Record<string, (...args: never[]) => unknown>
  return server
}

/** A local Claude agent reports on `tab`'s pane and the store names it; it is open until it sleeps. */
async function report(server: IdentityTestServer, tab: number, session: string) {
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
  return id
}

/** Local Claude agents that reported once, each named by the store, then put to sleep. */
async function sleptAgents(sessions: string[]) {
  const server = await started()
  const ids: OrcaSessionId[] = []
  for (const [tab, session] of sessions.entries()) {
    ids.push(await report(server, tab, session))
    server.dropStatusEntry(pane(tab), { preserveResumeIdentity: false })
  }
  server.identityClient.idsOfKeysRequests = 0
  server.identityClient.idsOfKeysKeys = 0
  server.identityClient.providerKeyRequests = 0
  return { server, ids }
}

/** `count` saved records: tab 0's session `session-a`, the rest never named, split over A and B. */
function savedRecords(count: number): Record<string, SleepingAgentSessionRecord> {
  const records: Record<string, SleepingAgentSessionRecord> = {
    [pane(0)]: record(0, 'session-a', 'DELTA done')
  }
  for (let index = 1; index < count; index++) {
    records[`tab-x${index}:1`] = {
      ...record(0, `never-${index}`, ''),
      paneKey: `tab-x${index}:1`,
      worktreeId: index % 2 === 0 ? WORKTREE : OTHER
    }
  }
  return records
}

function runtime(
  records: Record<string, SleepingAgentSessionRecord>,
  agents: Partial<RuntimeWorktreeAgentRow>[] = []
) {
  const ps = {
    worktrees: [
      { worktreeId: WORKTREE, displayName: 'delta', repo: 'repo', agents },
      { worktreeId: OTHER, displayName: 'echo', repo: 'repo', agents: [] }
    ],
    totalCount: 2,
    truncated: false
  }
  const host = {
    labels: 0,
    namers: 0,
    saved: records,
    orchestrationSenderNames: {
      agentRowNamer: () => {
        host.namers++
        return () => null
      }
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing reads only each worktree's id, labels and agent rows.
    getWorktreePs: async () => ps as unknown as RuntimeWorktreePsResult,
    readLocalSleepingAgentSessions: () => host.saved,
    getWorkspaceLabel: (worktreeId: string) => {
      host.labels++
      return worktreeId === WORKTREE
        ? { workspace: 'delta', repo: 'repo' }
        : worktreeId === OTHER
          ? { workspace: 'echo', repo: 'repo' }
          : null
    }
  }
  return host
}

it.each([100, 1_000])(
  'asks the store once for %i sleeping agents across repeated lists, and again for a new store',
  async (count) => {
    const { server, ids } = await sleptAgents(['session-a'])
    const host = runtime(savedRecords(count))

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

it("shows an asleep agent's id once the store names it after a list found none", async () => {
  const server = await started()
  const host = runtime({
    [pane(5)]: record(5, 'session-late', 'late reply'),
    [pane(6)]: record(6, 'session-never', 'never named')
  })
  const idOf = async (tab: number) =>
    (await listAgentConversations(host, 10)).agents.find((row) => row.paneKey === pane(tab))
      ?.orcaSessionId
  expect(await idOf(5)).toBeNull()

  // It wakes, reports and is named, then sleeps again with the same saved key.
  const named = await report(server, 5, 'session-late')
  server.dropStatusEntry(pane(5), { preserveResumeIdentity: false })

  expect(await idOf(5)).toBe(named)
  // The still-unnamed key is not asked again either.
  expect(await idOf(6)).toBeNull()
  expect(server.identityClient.idsOfKeysRequests).toBe(1)
  expect(server.identityClient.identifyRequests).toBe(1)
})

it.each([100, 1_000])(
  'answers %i saved agents once for callers listing different workspaces',
  async (count) => {
    const { server, ids } = await sleptAgents(['session-a'])
    const host = runtime(savedRecords(count))

    await listAgentConversations(host, 10)
    for (let round = 0; round < 12; round++) {
      const a = await listAgentConversations(host, 10, { worktreeId: WORKTREE })
      const b = await listAgentConversations(host, 10, { worktreeId: OTHER })
      const all = await listAgentConversations(host, 10)
      expect(a.agents.length + b.agents.length).toBe(count)
      expect(all.agents.find((row) => row.paneKey === pane(0))?.orcaSessionId).toBe(ids[0])
    }
    expect(server.identityClient.idsOfKeysRequests).toBe(1)
    expect(server.identityClient.idsOfKeysKeys).toBe(count)

    // A new saved record is the only key asked; removing one asks nothing.
    host.saved = { ...host.saved, [pane(9)]: record(9, 'session-new', '') }
    await listAgentConversations(host, 10, { worktreeId: OTHER })
    await listAgentConversations(host, 10)
    const { [pane(9)]: _added, ...rest } = host.saved
    host.saved = rest
    await listAgentConversations(host, 10)
    expect(server.identityClient.idsOfKeysRequests).toBe(2)
    expect(server.identityClient.idsOfKeysKeys).toBe(count + 1)
  }
)

it.each([100, 1_000])(
  'does no saved-agent work a state filter excludes, over %i saved agents',
  async (count) => {
    const { server, ids } = await sleptAgents(['session-a'])
    // Tab 0 woke with no new reply; the rest are asleep.
    const records = savedRecords(count)
    records[pane(0)] = { ...records[pane(0)]!, origin: 'live' }
    const host = runtime(records, [
      {
        paneKey: pane(0),
        orcaSessionId: ids[0],
        agentType: 'claude',
        state: 'working',
        lastAssistantMessage: null,
        updatedAt: 50
      }
    ])

    for (let call = 0; call < 12; call++) {
      expect((await listAgentConversations(host, 10, { state: 'working' })).agents).toEqual([
        expect.objectContaining({ orcaSessionId: ids[0], lastAssistantMessage: 'DELTA done' })
      ])
    }
    // Only the working row's own record was asked for, once; no asleep row was labelled.
    expect(server.identityClient.idsOfKeysKeys).toBe(1)
    expect(host.labels).toBe(0)
    expect(host.namers).toBe(0)

    const asleep = await listAgentConversations(host, 10, { state: 'asleep' })
    expect(asleep.agents).toHaveLength(count - 1)
    expect(asleep.agents.every((row) => row.state === 'asleep')).toBe(true)
    // One namer names every asleep row, however many there are.
    expect(host.namers).toBe(1)
  }
)

it('keeps the ids it knows when the store cannot answer a new saved agent', async () => {
  const { server, ids } = await sleptAgents(['session-a'])
  const host = runtime(savedRecords(100))
  const idOf = (agents: { paneKey: string; orcaSessionId: string | null }[], tab: number) =>
    agents.find((row) => row.paneKey === pane(tab))?.orcaSessionId
  expect(idOf((await listAgentConversations(host, 10)).agents, 0)).toBe(ids[0])

  let failed = 0
  server.identityClient.idsOfKeys = async () => {
    failed++
    return undefined
  }
  host.saved = { ...host.saved, [pane(9)]: record(9, 'session-new', '') }
  for (let call = 0; call < 12; call++) {
    const listed = (await listAgentConversations(host, 10)).agents
    expect(idOf(listed, 0)).toBe(ids[0])
    expect(idOf(listed, 9)).toBeNull()
  }
  // The failure backoff holds every later list's question.
  expect(failed).toBe(1)
})

/** Holds the store's next `idsOfKeys` answer until released. */
function holdKeyLookups(client: InProcessAgentIdentityClient) {
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const answer = client.idsOfKeys.bind(client)
  client.idsOfKeys = async (...args) => {
    await released
    return answer(...args)
  }
  return release
}

const idOf = async (host: ReturnType<typeof runtime>, tab: number) =>
  (await listAgentConversations(host, 10)).agents.find((row) => row.paneKey === pane(tab))
    ?.orcaSessionId

it('shows an id the store committed after the last pane asking for it left', async () => {
  const server = await started()
  const host = runtime({ [pane(5)]: record(5, 'session-late', 'late reply') })
  expect(await idOf(host, 5)).toBeNull()

  // It reports, and its naming is sent; the pane sleeps before the store answers.
  server.identityClient.hold = true
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-late',
        transcript_path: '/home/u/.claude/projects/p/session-late.jsonl',
        prompt: 'task'
      },
      { paneKey: pane(5), tabId: 'tab-5' }
    ),
    'production'
  )
  server.ingestRemote(event!, null)
  await new Promise((resolve) => setImmediate(resolve))
  expect(server.identityClient.identifyRequests).toBe(1)
  server.dropStatusEntry(pane(5), { preserveResumeIdentity: false })
  server.identityClient.release()
  await new Promise((resolve) => setImmediate(resolve))
  const linked = await server.terminalAgentIdsOfProviderSession('session-late')
  const named = Array.isArray(linked) ? linked[0] : undefined

  expect(named).toMatch(/^claude_/)
  expect(await idOf(host, 5)).toBe(named)
  expect(server.identityClient.idsOfKeysRequests).toBe(1)
})

it.each(['switches', 'clears', 'closes'] as const)(
  'returns no id of a store whose authority ends while a list waits on it (it %s)',
  async (end) => {
    const { server, ids } = await sleptAgents(['session-a'])
    const host = runtime(savedRecords(1))
    expect(await idOf(host, 0)).toBe(ids[0])
    host.saved = { ...host.saved, [pane(9)]: record(9, 'session-new', '') }
    const release = holdKeyLookups(server.identityClient)

    const listing = idOf(host, 0)
    await new Promise((resolve) => setImmediate(resolve))
    if (end === 'switches') {
      server.moveStatusFile(join(directory(), 'status.json'))
    } else if (end === 'clears') {
      server.moveStatusFile(null)
    } else {
      server.stop()
    }
    release()

    expect(await listing).toBeNull()
  }
)

it('drops ids of saved agents that are gone, and asks again when one comes back', async () => {
  const { server, ids } = await sleptAgents(['session-a'])
  const host = runtime(savedRecords(100))
  await listAgentConversations(host, 10)
  expect(server.identityClient.idsOfKeysKeys).toBe(100)

  host.saved = {}
  for (const filter of [{}, { worktreeId: WORKTREE }, { state: 'working' as const }]) {
    expect((await listAgentConversations(host, 10, filter)).agents).toEqual([])
  }
  host.saved = { [pane(0)]: record(0, 'session-a', 'DELTA done') }

  expect(await idOf(host, 0)).toBe(ids[0])
  expect(server.identityClient.idsOfKeysKeys).toBe(101)
})

it('keeps out an answer for a saved agent removed while it was asked', async () => {
  const { server } = await sleptAgents(['session-a'])
  const host = runtime(savedRecords(1))
  await listAgentConversations(host, 10)
  const late = record(9, 'session-late', '')
  host.saved = { ...host.saved, [pane(9)]: late }
  const release = holdKeyLookups(server.identityClient)
  const listing = listAgentConversations(host, 10)
  await new Promise((resolve) => setImmediate(resolve))

  // The record goes; another list sees the map without it, then the old answer arrives.
  const { [pane(9)]: _removed, ...rest } = host.saved
  host.saved = rest
  await listAgentConversations(host, 10)
  release()
  await listing
  host.saved = { ...host.saved, [pane(9)]: late }
  await listAgentConversations(host, 10)

  expect(server.identityClient.idsOfKeysKeys).toBe(3)
})
