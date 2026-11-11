import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { isOrcaSessionId, formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { createCrewPartyRegistry } from './crew-parties'
import { createCrewRecipientInputs } from './crew-recipient-inputs'

import { LEGACY_CONTRACT_VERSION } from '../db/contract-constants'
import { ORCHESTRATION_LEGACY_RUN_ID as LEGACY_RUN_ID } from '../../../../shared/orchestration/orchestration-rpc-contract'

import { subscribeCrew } from './crew-stream'

const LOCAL = testOrcaSessionId('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
const IMPORTED = testOrcaSessionId('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
const record = (sessionId: string) =>
  agentSessionConversationView(agentSessionRecordFixture({ sessionId }))

function authorityFixture() {
  const f = fixture()
  const records = new Map<string, ReturnType<typeof record>>(
    [LOCAL, IMPORTED].map((id) => [id, record(id)])
  )
  records.delete(IMPORTED)
  const visible = new Set([LOCAL])
  f.deps.records = {
    listRecords: () => [...records.values()],
    getRecord: (id) => records.get(id) ?? null,
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] })
  }
  const input = () => {
    const registry = createCrewPartyRegistry(f.deps)
    return createCrewRecipientInputs(f.db, registry.records, registry.commandCanonical, () =>
      f.db.getLegacyAdoptedRunMailboxOwner()
    )
  }
  const available = (ids: string[], senderRun?: string) => {
    const selected = ids.filter(isOrcaSessionId)
    const facts = input()
    facts.prepare(selected)
    return facts.finish(selected, senderRun, { livePane: () => null, process: () => null })
  }
  return { ...f, records, visible, input, available }
}

it('re-derives retained legacy custody on actual commit/revoke/reset writers', async () => {
  const f = authorityFixture()
  const peer = formatOrcaSessionAddress(IMPORTED)
  // Retained adoption-table control; migration admission remains covered by the existing legacy fixtures.
  f.db.db
    .prepare(
      'INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost, adopted_at) VALUES (?, ?, 1, ?)'
    )
    .run(LEGACY_RUN_ID, f.run.id, '2099-01-01 00:00:00')
  f.db.db
    .prepare(
      "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, scheduler_lost_at) VALUES (?, ?, 'failed', ?, ?)"
    )
    .run('retained-c2', 'retained coordinator', peer, '2099-01-01 00:00:00')
  const task = f.db.createTask({ runId: f.run.id, spec: 'active individual route' })
  const dispatch = f.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: formatOrcaSessionAddress(LOCAL),
    creator: { kind: 'system' },
    maxDepth: 10
  })
  const facts = f.input()
  facts.prepare([LOCAL, IMPORTED])
  const allowed = facts.finish([LOCAL, IMPORTED], undefined, {
    livePane: () => null,
    process: () => null
  })
  expect(allowed(LOCAL)).toBe(true)
  expect(allowed(IMPORTED)).toBe(true)
  f.db.db
    .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id = ?')
    .run(LEGACY_CONTRACT_VERSION, dispatch.id)
  f.db.insertMessage({
    from: peer,
    to: 'term_worker',
    subject: 'retained target',
    body: 'retained target'
  })
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const stop = subscribeCrew(
    () => model.read('term_worker'),
    model.subscribe,
    () => {}
  )
  try {
    const row = () =>
      model
        .read('term_worker')
        .sections.talkingWith.find((row) => row.latest?.preview === 'retained target')
    expect(row()?.sendAddress).toBe(peer)
    const principal = f.db.commitLegacyCompatibilityPrincipal({
      runId: f.run.id,
      dispatchId: dispatch.id,
      role: 'worker',
      hostScope: 'local:fixture',
      terminalHandle: peer,
      paneKey: 'legacy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      launchTokenHash: 'fixture-only',
      processIncarnation: 'fixture-only'
    })
    await Promise.resolve()
    expect(row()).not.toHaveProperty('sendAddress')
    f.db.setLegacyCompatibilityPrincipalStatus(principal.principal.id, 'revoked')
    await Promise.resolve()
    expect(row()?.sendAddress).toBe(peer)
    f.db.setLegacyCompatibilityPrincipalStatus(principal.principal.id, 'revoked')
    await Promise.resolve()
    f.db.resetMessages()
    await Promise.resolve()
    expect(model.read('term_worker').sections.talkingWith).toEqual([])
  } finally {
    stop()
  }
})
