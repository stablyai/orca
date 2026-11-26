import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import type { OrchestrationWorkerServer } from '../../federation/environment-transport'
import { importRemoteOwnedItem } from './remote-owned-import'
import { recordRemoteStart, reserveRemotePlacement } from './remote-placements'
import { openRemoteRunLink, remoteServerPin } from './remote-run-links'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_g16',
  name: 'g16',
  peerFingerprint: 'fp_server',
  homePeerFingerprint: 'fp_home',
  pairingRevision: 1
}
const TASK = 'task_0123456789ab'
const open: OrchestrationDb[] = []

afterEach(() => {
  open.splice(0).forEach((db) => db.close())
})

/** A report sent by a worker on the paired server, imported here as mail delivery reads it. */
function importReport(payload: Record<string, unknown>): string {
  const home = new OrchestrationDb(':memory:')
  const server = new OrchestrationDb(':memory:')
  open.push(home, server)
  const runId = home.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: null
  }).id
  const link = openRemoteRunLink(home, runId, SERVER)
  reserveRemotePlacement(home, {
    link,
    taskId: TASK,
    requestKey: 'key',
    create: { spec: 'work' },
    creator: { kind: 'system' }
  })
  const peerRunId = server.admitPeerRun({
    peerFingerprint: 'fp_home',
    peerRun: { runId, conversationId: link.conversation_id, label: 'home' }
  }).run_id
  server.createTask({ id: TASK, spec: 'work', runId: peerRunId })
  const dispatchId = createRootDispatch(server, TASK, 'term_worker').id
  recordRemoteStart(home, {
    conversationId: link.conversation_id,
    taskId: TASK,
    dispatchId,
    requestKey: 'key',
    peerRunId
  })
  const sent = server.insertMessage({
    from: 'term_worker',
    to: `run:${peerRunId}`,
    subject: 'Worker hit an error',
    body: 'Error: Claude is not signed in.',
    type: 'escalation',
    payload: JSON.stringify({ dispatchId, ...payload }),
    runId: peerRunId,
    senderDispatchId: dispatchId
  })
  const items = server.db
    .prepare(
      `SELECT sequence, message_id AS messageId, kind, payload FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = 'to_home' ORDER BY sequence`
    )
    .all(link.conversation_id)
  for (const item of items) {
    importRemoteOwnedItem(home, remoteServerPin(SERVER), {
      sequence: Number(item.sequence),
      messageId: String(item.messageId),
      kind: String(item.kind),
      payload: String(item.payload),
      conversationId: link.conversation_id
    })
  }
  return home.getMessageById(sent.id)!.body
}

it("names the paired server a worker's agent needs signing in on", () => {
  expect(importReport({ agent: 'claude', failureKind: 'notSignedIn' })).toBe(
    "Claude on g16 isn't signed in: run `claude auth login` there.\nError: Claude is not signed in."
  )
})

it('leaves every other report as the server wrote it', () => {
  expect(importReport({ agent: 'claude', failureKind: 'usageLimitReached' })).toBe(
    'Error: Claude is not signed in.'
  )
})
