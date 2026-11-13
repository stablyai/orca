import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { closeRemoteRunLink, openRemoteRunLink } from '../../db/remote-owned/remote-run-links'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { PeerMailRelay } from './peer-mail-relay'

const SERVER: OrchestrationWorkerServer = {
  environmentId: 'env_b',
  name: 'devB',
  peerFingerprint: 'host_b',
  homePeerFingerprint: 'cred_a',
  pairingRevision: 1
}

let relay: PeerMailRelay | null = null
afterEach(() => relay?.stop())

it("stops pulling from a server once this Orca's last link to it closes", async () => {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'remote work',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
  })
  const link = openRemoteRunLink(db, run.id, SERVER)
  let pulls = 0
  const runtime = {
    getOrchestrationDb: () => db,
    resolveOrchestrationWorkerServer: () => SERVER,
    notifyMessageArrived: vi.fn(),
    callOrchestrationWorkerServer: async (_environmentId: string, method: string) => {
      if (method === 'orchestration.peerMailPull') {
        pulls += 1
        if (pulls === 2) {
          closeRemoteRunLink(db, link.conversation_id, 'The Run ended.')
        }
        // An idle pull answers empty after its wait.
        await new Promise((resolve) => setImmediate(resolve))
      }
      return { items: [] }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay reads only these runtime members.
  relay = new PeerMailRelay(runtime as never, () => ({}) as never)

  relay.ensure()
  await vi.waitFor(() => expect(pulls).toBeGreaterThanOrEqual(2))
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  expect(pulls).toBe(2)
})
