import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { importRemoteOwnedItem } from './remote-owned-import'
import { adoptRemoteAttempt, reserveRemotePlacement } from './remote-placements'
import { getRemoteDispatch } from './remote-dispatch-records'
import {
  closeRemoteRunLink,
  openRemoteRunLink,
  remoteServerPin,
  type RemoteRunLinkRow
} from './remote-run-links'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_server',
  name: 'Server',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const CHAT = testOrcaSessionId('starting-chat')
const TASK = 'task_0123456789ab'

// Every way a server's Dispatch becomes known here stamps the chat that started its work.
describe('the creator of a worker a paired server runs', () => {
  let home: OrchestrationDb
  let server: OrchestrationDb
  let link: RemoteRunLinkRow
  let peerRunId: string

  beforeEach(() => {
    imported = 0
    home = new OrchestrationDb(':memory:')
    server = new OrchestrationDb(':memory:')
    const homeRunId = home.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    link = openRemoteRunLink(home, homeRunId, SERVER)
    reserveRemotePlacement(home, {
      link,
      taskId: TASK,
      requestKey: 'key',
      create: { spec: 'work' },
      creator: { kind: 'session', orcaSessionId: CHAT }
    })
    peerRunId = server.admitPeerRun({
      peerFingerprint: 'fp_home',
      peerRun: { runId: homeRunId, conversationId: link.conversation_id, label: 'home' }
    }).run_id
  })
  afterEach(() => {
    home.close()
    server.close()
  })

  /** A worker the server starts and readies in `worktree`, as its ordinary start records it. */
  function startOnServer(
    taskId: string,
    worktree: string,
    earlier: { followUpOf?: string; creatorDispatchId?: string } = {}
  ): string {
    server.createTask({ id: taskId, spec: 'work', runId: peerRunId })
    const id = createRootDispatch(server, taskId, `term_${taskId}`).id
    server.db
      .prepare(
        'UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ?, creator_dispatch_id = ? WHERE id = ?'
      )
      .run(earlier.followUpOf ?? null, earlier.creatorDispatchId ?? null, id)
    server.db
      .prepare(
        "INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES (?, 'starting', ?)"
      )
      .run(id, worktree)
    server.db.prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?").run(id)
    return id
  }

  let imported = 0
  /** Imports everything the server queued home since the last import, as the relay does. */
  function importQueue(): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly these columns.
    const items = server.db
      .prepare(
        `SELECT sequence, message_id AS messageId, kind, payload FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = 'to_home' AND sequence > ? ORDER BY sequence`
      )
      .all(link.conversation_id, imported) as {
      sequence: number
      messageId: string
      kind: string
      payload: string
    }[]
    for (const item of items) {
      imported = item.sequence
      importRemoteOwnedItem(home, remoteServerPin(SERVER), {
        ...item,
        conversationId: link.conversation_id
      })
    }
  }

  const stamp = (dispatchId: string) => {
    const row = getRemoteDispatch(home, dispatchId)
    return { creator: row?.creator_orca_session_id, worktree: row?.worktree_id }
  }

  it('a start this Orca never heard answered (restart) keeps its workspace from the queue', () => {
    const first = startOnServer(TASK, 'repo::/first')
    importQueue()
    expect(stamp(first)).toEqual({ creator: CHAT, worktree: 'repo::/first' })
  })

  it("a follow-up and a worker's helper take the chat of the Dispatch before them, in any order", () => {
    const first = startOnServer(TASK, 'repo::/first')
    importQueue()
    const followUp = startOnServer('task_followup0001', 'repo::/first', { followUpOf: first })
    // The send's answer names it first, with nothing about who started it.
    adoptRemoteAttempt(home, link, { taskId: 'task_followup0001', dispatchId: followUp })
    const helper = startOnServer('task_helper000001', 'repo::/helper', {
      creatorDispatchId: followUp
    })
    importQueue()
    expect(stamp(followUp)).toEqual({ creator: CHAT, worktree: 'repo::/first' })
    expect(stamp(helper)).toEqual({ creator: CHAT, worktree: 'repo::/helper' })
  })

  it('an open worker stops running here once its server can no longer report it', () => {
    const first = startOnServer(TASK, 'repo::/first')
    importQueue()
    expect(home.listDispatchLinksByIds([first])[0]).toMatchObject({ status: 'dispatched' })
    closeRemoteRunLink(home, link.conversation_id, 'Pairing re-made.')
    expect(home.listDispatchLinksByIds([first])[0]).toMatchObject({
      status: 'failed',
      lastFailure: 'server_unlinked',
      completedAtKnown: true
    })
  })
})
