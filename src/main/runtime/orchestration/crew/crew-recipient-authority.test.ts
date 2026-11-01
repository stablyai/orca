import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { isOrcaSessionId, formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { createCrewPartyRegistry } from './crew-parties'
import { createCrewRecipientInputs } from './crew-recipient-inputs'
import { resolveMessageRun } from '../../rpc/methods/orchestration/routing'
import { OrcaRuntimeService } from '../../orca-runtime'
import { resolveBareOrchestrationRecipient } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID } from '../db/contract-constants'
import { federatedControlMailRefusal } from '../../rpc/methods/orchestration/messaging/send-control-mail'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'

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

it('keeps imported content and Open while deriving local close/reopen availability without mail and suppressing equal publications', async () => {
  const f = authorityFixture()
  for (const [id, body] of [
    [LOCAL, 'ordinary local'],
    [IMPORTED, 'moved imported']
  ] as const) {
    f.db.insertMessage({
      from: formatOrcaSessionAddress(id),
      to: 'term_worker',
      subject: 'Peer',
      body
    })
  }
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => model.read('term_worker'),
    model.subscribe,
    (frame) => frames.push(frame)
  )
  try {
    const peers = model.read('term_worker').sections.talkingWith
    expect(peers).toHaveLength(2)
    const local = peers.find((row) => row.latest?.preview === 'ordinary local')!
    const imported = peers.find((row) => row.latest?.preview === 'moved imported')!
    expect(local.sendAddress).toBe(formatOrcaSessionAddress(LOCAL))
    expect(local.openTarget).toMatchObject({ kind: 'chat', sessionId: LOCAL })
    expect(imported).not.toHaveProperty('sendAddress')
    const unchanged = frames.length
    f.db.crewChanges.notify(new Set(['topology']))
    await Promise.resolve()
    expect(frames).toHaveLength(unchanged)
    f.visible.clear()
    f.db.crewChanges.notify(new Set(['records']))
    await Promise.resolve()
    const closed = model
      .read('term_worker')
      .sections.talkingWith.find((row) => row.partyKey === local.partyKey)!
    const { sendAddress, ...retained } = local
    expect(sendAddress).toBeTruthy()
    expect(closed).toEqual(retained)
    f.visible.add(LOCAL)
    f.db.crewChanges.notify(new Set(['records']))
    await Promise.resolve()
    expect(
      model.read('term_worker').sections.talkingWith.find((row) => row.partyKey === local.partyKey)
    ).toEqual(local)
  } finally {
    stop()
  }
})

it('preserves missing clear successor and older visibility-index compatibility, independently of unknown message ID families', () => {
  const f = authorityFixture()
  delete f.deps.records!.getVisibleSessionTabIndex
  expect(f.available([LOCAL])(LOCAL)).toBe(true)
  const old = f.records.get(LOCAL)!
  f.records.set(LOCAL, {
    ...old,
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      callerKey: 'clear',
      operationId: 'clear-missing',
      replacementSessionId: IMPORTED
    }
  })
  expect(f.available([LOCAL])(LOCAL)).toBe(false)
  f.records.set(IMPORTED, record(IMPORTED))
  expect(f.available([LOCAL])(LOCAL)).toBe(true)
})

it('matches actual sender Dispatch R1 before coordinator R2 and never uses sender preference to disambiguate active recipient Dispatches', () => {
  const f = authorityFixture()
  const caller = {
    address: 'term_worker',
    terminalHandle: 'term_worker',
    paneKey: f.handles.get('term_worker')!,
    orcaSessionId: null
  }
  const second = f.db.createRun({
    objective: 'caller coordinates R2',
    coordinatorHandle: caller.address,
    coordinatorPaneKey: caller.paneKey
  })
  const createDispatch = (handle: string, pane: string | undefined) =>
    f.db.createDispatchContext({
      taskId: f.db.createTask({ spec: handle, runId: f.run.id }).id,
      assigneeHandle: handle,
      assigneePaneKey: pane,
      creator: { kind: 'system' },
      maxDepth: 10
    })
  createDispatch(caller.address, caller.paneKey)
  const peer = formatOrcaSessionAddress(IMPORTED)
  for (const id of [f.run.id, second.id]) {
    f.db.rememberRunCoordinatorHandle(id, peer)
  }
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(f.db)
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockReturnValue(null)
  const ordinary = resolveMessageRun(runtime, { sender: caller, to: peer })
  expect(ordinary.run?.id).toBe(f.run.id)
  const facts = f.input()
  const selectedCaller = facts.prepare([IMPORTED], caller)
  expect(facts.senderRun(selectedCaller)).toEqual({ kind: 'ready', id: ordinary.run!.id })
  expect(
    facts.finish([IMPORTED], ordinary.run!.id, { livePane: () => null, process: () => null })(
      IMPORTED
    )
  ).toBe(true)
  expect(
    resolveBareOrchestrationRecipient({
      runtime,
      db: f.db,
      handle: peer,
      senderRunId: ordinary.run!.id
    })
  ).toMatchObject({ ok: true, to: `run:${f.run.id}` })
  f.db.insertMessage({ from: peer, to: caller.address, subject: 'history' })
  expect(
    new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe).read(caller.address).sections
      .talkingWith[0].sendAddress
  ).toBe(peer)
  const one = createDispatch('term_peer_one', undefined)
  const two = createDispatch('term_peer_two', undefined)
  // Retained duplicate-owner control; ordinary creation protects an already occupied assignee.
  f.db.db
    .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id IN (?, ?)')
    .run(peer, one.id, two.id)
  const blocked = f.input()
  const actualCaller = blocked.prepare([IMPORTED], caller)
  const sender = blocked.senderRun(actualCaller)
  expect(sender).toEqual({ kind: 'ready', id: f.run.id })
  expect(
    blocked.finish([IMPORTED], f.run.id, { livePane: () => null, process: () => null })(IMPORTED)
  ).toBe(false)
  expect(
    resolveBareOrchestrationRecipient({ runtime, db: f.db, handle: peer, senderRunId: f.run.id })
  ).toMatchObject({ ok: false, code: 'recipient_ambiguous' })
})

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
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => model.read('term_worker'),
    model.subscribe,
    (frame) => frames.push(frame)
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
    const before = frames.length
    f.db.setLegacyCompatibilityPrincipalStatus(principal.principal.id, 'revoked')
    await Promise.resolve()
    expect(frames).toHaveLength(before)
    f.db.resetMessages()
    await Promise.resolve()
    expect(model.read('term_worker').sections.talkingWith).toEqual([])
  } finally {
    stop()
  }
})

it('uses the existing federated protocol/ready refusal after an actual selected Dispatch, independently of missing native records', () => {
  const f = authorityFixture()
  const target = f.db.createStartingWorkerDispatch({
    taskSpec: 'federated target',
    taskRunId: f.run.id,
    creator: { kind: 'system' },
    maxDepth: 10,
    startOptions: {},
    federation: {
      environmentId: 'fixture-remote',
      environmentName: 'remote',
      peerFingerprint: 'fixture-peer',
      protocolVersion: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
    }
  })
  f.db.prepareStartingWorkerAuthority({
    dispatchId: target.dispatch.id,
    handle: formatOrcaSessionAddress(IMPORTED),
    paneKey: 'remote:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    processIncarnation: 'fixture-remote-process',
    worktreeId: 'fixture-remote-folder',
    effects: [],
    setupState: 'not_applicable'
  })
  expect(f.available([IMPORTED])(IMPORTED)).toBe(false)
  expect(
    federatedControlMailRefusal(
      target.dispatch.id,
      ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
      () => f.db.getWorkerDispatch(target.dispatch.id)?.state
    )?.code
  ).toBe('dispatch_inactive')
  f.db.markWorkerDispatchReady(target.dispatch.id)
  expect(f.available([IMPORTED])(IMPORTED)).toBe(true)
  // Retained old-version control uses the same existing refusal and no native fallback escape.
  f.db.db
    .prepare('UPDATE federated_dispatches SET protocol_version = ? WHERE dispatch_id = ?')
    .run(ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION - 1, target.dispatch.id)
  expect(f.available([IMPORTED])(IMPORTED)).toBe(false)
  expect(
    federatedControlMailRefusal(
      target.dispatch.id,
      ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION - 1,
      () => 'ready'
    )?.code
  ).toBe('capability_unsupported')
  expect(f.db.getInbox()).toEqual([])
})
