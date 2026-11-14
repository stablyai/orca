import { beforeEach, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/orca-session-address'

const identity = vi.hoisted(() => ({
  terminalAgentPlaces: vi.fn<(id: string) => Promise<{ paneKey: string }[] | null>>(),
  chats: new Set<string>()
}))
vi.mock('../../../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { terminalAgentPlaces: identity.terminalAgentPlaces }
}))
vi.mock('../../../../orchestration/addressing/session-lineage/structured-session-lineage', () => ({
  readAgentSessionRecordStore: () => ({})
}))
vi.mock('../../../../orchestration/mailbox/routing/structured-session-mail-address', () => ({
  lookupOrcaAgentSession: (_store: unknown, id: string) =>
    identity.chats.has(id) ? { kind: 'found', record: {} } : { kind: 'unknown' },
  structuredSessionMailReach: () => ({ kind: 'local' })
}))
// Group selection is what this file checks; the sender's own mailbox routing is out of scope.
vi.mock('./recipient-routing', () => ({
  resolveBareOrchestrationRecipient: ({ handle }: { handle: string }) => ({
    ok: true,
    to: handle,
    runId: 'run_1'
  })
}))
vi.mock('../routing', () => ({ legacyWorkerDeliveryContract: () => undefined }))
vi.mock('../../../../orchestration/addressing/groups/structured-worker-group-addressing', () => ({
  listAddressableStructuredWorkers: () => []
}))

import {
  readSessionRecipient,
  refuseUndeliverableSessionRecipient,
  resolveTerminalAgentRecipient
} from './session-recipient'
import { sendGroupMessage } from './send-group'

const CHAT = 'codex_0123456789abcdef'
const TERMINAL = 'claude_0123456789abcdef'

beforeEach(() => {
  identity.chats.clear()
  identity.terminalAgentPlaces.mockReset()
})

it('decides a known chat from the chat store alone and refuses a cold terminal id', async () => {
  identity.chats.add(CHAT)
  // A broken identity worker never answers; a chat recipient must not wait on it.
  identity.terminalAgentPlaces.mockReturnValue(new Promise(() => {}))
  expect(await resolveTerminalAgentRecipient(`orca_session_id:${CHAT}`)).toBeNull()
  expect(identity.terminalAgentPlaces).not.toHaveBeenCalled()

  // A conversation no row carries now is still a terminal agent once the store confirms it.
  identity.terminalAgentPlaces.mockResolvedValue([])
  const terminal = await resolveTerminalAgentRecipient(TERMINAL)
  expect(terminal).toEqual({ sessionId: TERMINAL, places: [] })
  expect(readSessionRecipient(TERMINAL, null, terminal)).toMatchObject({
    code: 'session_caller_terminal_agent'
  })
  if (!isOrcaSessionId(TERMINAL)) {
    throw new Error('expected an Orca session id')
  }
  const recipient = { sessionId: TERMINAL, address: formatOrcaSessionAddress(TERMINAL) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal refusal returns before any database read.
  const db = {} as OrchestrationDb
  expect(refuseUndeliverableSessionRecipient(recipient, null, db, terminal)?.message).toBe(
    `Agent ${TERMINAL} is a terminal agent. Messaging terminal agents by ID isn't supported yet; address its terminal instead. No message was sent.`
  )
})

type GroupWorld = {
  /** Live Dispatches of the sender's Run, by worker terminal handle. */
  dispatches: Map<string, string>
  terminals: { handle: string; worktreeId: string; agentIdentity?: string }[]
  statuses: Map<string, string>
  /** Runs inside each status read, as other work may while a journal opens. */
  duringStatusRead?: () => void
  revalidate?: () => string
}

function groupSend(groupAddress: string, world: GroupWorld) {
  const written: string[][] = []
  const db = {
    getCoordinatedRun: () => undefined,
    getCurrentRunForCoordinator: () => undefined,
    getActiveDispatchForIdentity: () => undefined,
    listWorkerTerminalResources: () =>
      [...world.dispatches].map(([handle, dispatchId]) => ({
        dispatchStatus: 'dispatched',
        dispatchId,
        runId: 'run_1',
        paneKey: `tab:${handle}`,
        agentTerminalHandle: handle,
        worktreeId: 'w'
      })),
    listFederatedDispatchesByIds: () => [],
    getCurrentRunForPane: () => undefined,
    getLegacyAdoptedRunMailboxOwner: () => null,
    insertMessages: (rows: { to: string }[]) => {
      written.push(rows.map((row) => row.to))
      return rows
    }
  }
  const runtime = {
    listTerminals: async () => ({ terminals: world.terminals }),
    getAgentStatusForHandle: async (handle: string) => {
      world.duringStatusRead?.()
      return world.statuses.get(handle) ?? null
    },
    getTerminalHandleForPaneKey: (paneKey: string) => paneKey.slice('tab:'.length),
    getLiveTerminalPaneKey: (handle: string) => `tab:${handle}`,
    getLegacyAdoptedRunMailboxOwner: () => null,
    notifyMessageArrived: () => {}
  }
  const args = {
    params: { subject: 'test', body: 'body' },
    runtime,
    db,
    from: 'term_coord',
    groupAddress,
    sender: { terminalHandle: 'term_coord', paneKey: 'tab:coord', orcaSessionId: null },
    senderPaneKey: 'tab:coord',
    senderRunId: 'run_1',
    explicitRunId: undefined,
    legacyCoordinatorRunId: 'run_1',
    revalidateLegacyCoordinator: world.revalidate ?? (() => 'run_1'),
    recordMutationReceipt: undefined,
    withSendWarnings: <T>(receipt: T) => receipt
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a group send reads only these runtime and database members.
  const sent = sendGroupMessage(args as unknown as Parameters<typeof sendGroupMessage>[0])
  return { sent, written }
}

function stableWorld(): GroupWorld {
  return {
    dispatches: new Map([['term_a', 'dispatch_a']]),
    terminals: [{ handle: 'term_a', worktreeId: 'w1', agentIdentity: 'claude' }],
    statuses: new Map([['term_a', 'idle']])
  }
}

it.each([
  ['@all', ['dispatch:dispatch_a']],
  ['@idle', ['dispatch:dispatch_a']],
  ['@worktree:w1', ['term_a']],
  ['@claude', ['dispatch:dispatch_a']]
])('routes %s to its host-issued candidates with no identity lookup', async (group, to) => {
  // A hung identity worker: group candidates are handles, worker ids and mailboxes, never ids
  // to classify, so the send cannot wait on it.
  identity.terminalAgentPlaces.mockReturnValue(new Promise(() => {}))
  const { sent, written } = groupSend(group, stableWorld())
  await sent
  expect(written).toEqual([to])
  expect(identity.terminalAgentPlaces).not.toHaveBeenCalled()
})

it('selects @idle recipients from the facts current after the status read', async () => {
  // While statuses were read, A went busy and B was dispatched: B's own status is read too.
  const world = stableWorld()
  world.duringStatusRead = () => {
    world.statuses.set('term_a', 'busy')
    world.dispatches.set('term_b', 'dispatch_b')
    world.statuses.set('term_b', 'idle')
  }
  const changed = groupSend('@idle', world)
  await changed.sent
  expect(changed.written).toEqual([['dispatch:dispatch_b']])

  // The worker moved to another Dispatch during the read: mail follows its current mailbox.
  const moving = stableWorld()
  moving.duringStatusRead = () => moving.dispatches.set('term_a', 'dispatch_a2')
  const moved = groupSend('@idle', moving)
  await moved.sent
  expect(moved.written).toEqual([['dispatch:dispatch_a2']])

  // Authority revoked during the read: nothing is written.
  let valid = true
  const revoking = stableWorld()
  revoking.duringStatusRead = () => {
    valid = false
  }
  revoking.revalidate = () => {
    if (!valid) {
      throw new Error('revoked')
    }
    return 'run_1'
  }
  const revoked = groupSend('@idle', revoking)
  await expect(revoked.sent).rejects.toThrow('revoked')
  expect(revoked.written).toEqual([])
})
