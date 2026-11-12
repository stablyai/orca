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

function groupSend(dispatchIds: () => string[], revalidate: () => string) {
  const written: string[][] = []
  const db = {
    getCoordinatedRun: () => undefined,
    getCurrentRunForCoordinator: () => undefined,
    getActiveDispatchForIdentity: () => undefined,
    listWorkerTerminalResources: () =>
      dispatchIds().map((dispatchId) => ({
        dispatchStatus: 'dispatched',
        dispatchId,
        runId: 'run_1',
        paneKey: 'tab:worker',
        agentTerminalHandle: 'term_worker',
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
    getTerminalHandleForPaneKey: () => 'term_worker',
    getLiveTerminalPaneKey: () => 'tab:worker',
    getLegacyAdoptedRunMailboxOwner: () => null,
    notifyMessageArrived: () => {}
  }
  const args = {
    params: { subject: 'test', body: 'body' },
    runtime,
    db,
    from: 'term_coord',
    groupAddress: '@all',
    sender: { terminalHandle: 'term_coord', paneKey: 'tab:coord', orcaSessionId: null },
    senderPaneKey: 'tab:coord',
    senderRunId: 'run_1',
    explicitRunId: undefined,
    legacyCoordinatorRunId: 'run_1',
    revalidateLegacyCoordinator: revalidate,
    recordMutationReceipt: undefined,
    withSendWarnings: <T>(receipt: T) => receipt
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an @all group send reads only these runtime and database members.
  const sent = sendGroupMessage(args as unknown as Parameters<typeof sendGroupMessage>[0])
  return { sent, written }
}

it('writes group mail only under authority and mailboxes that still hold after the wait', async () => {
  // Authority revoked while the recipients' terminal identities were being resolved.
  let valid = true
  const revoked = groupSend(
    () => ['dispatch_1'],
    () => {
      if (!valid) {
        throw new Error('revoked')
      }
      queueMicrotask(() => {
        valid = false
      })
      return 'run_1'
    }
  )
  await expect(revoked.sent).rejects.toThrow('revoked')
  expect(revoked.written).toEqual([])

  // The worker moved to another Dispatch during the wait: mail follows its current mailbox.
  let dispatch = 'dispatch_1'
  const moved = groupSend(
    () => [dispatch],
    () => {
      queueMicrotask(() => {
        dispatch = 'dispatch_2'
      })
      return 'run_1'
    }
  )
  await moved.sent
  expect(moved.written).toEqual([['dispatch:dispatch_2']])
})
