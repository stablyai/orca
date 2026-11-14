import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress as address } from '../../../../shared/orca-session-address'
import { fixture } from './crew-read-model.test-fixture'

export const SELF = testOrcaSessionId('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
export const TARGET = testOrcaSessionId('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')

export const crewRecord = (sessionId: string) =>
  agentSessionConversationView(agentSessionRecordFixture({ sessionId }))

export function deltaFixture(peers = 0) {
  const f = fixture()
  const records = new Map([[SELF.toString(), crewRecord(SELF)]])
  for (let i = 0; i < peers; i++) {
    const id = testOrcaSessionId(`chat-delta-${i}`)
    records.set(id, crewRecord(id))
    f.db.insertMessage({ from: address(id), to: address(SELF), subject: 'Peer', body: `peer ${i}` })
  }
  const visible = new Set(records.keys())
  f.deps.records = {
    listRecords: () => [...records.values()],
    getRecord: (id) => records.get(id) ?? null,
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] })
  }
  return { ...f, records, visible }
}

export function remembered(f: ReturnType<typeof deltaFixture>, id = TARGET, count = 2) {
  const runs = Array.from({ length: count }, (_, i) =>
    f.db.createRun({
      objective: `history ${i}`,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: id
    })
  )
  f.db.unbindOtherRunsForCoordinator(
    { terminalHandle: null, paneKey: null, orcaSessionId: id },
    f.run.id
  )
  return runs
}
