import '../unused-default-rpc-methods.test-fixture'
vi.mock('node:fs/promises', { spy: true })
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import { hostTestOperationId } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD,
  restTestSend
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { closeStructuredAgentSessionChild } from '../../agent-session/structured-agent-session-close'
import { discardStructuredWorkerSession } from './orchestration-structured-worker-session'
import { claudeAndCodexDeclared } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'

import { fixture, call, restingChat } from './structured-agent-session-rest-contract-test-fixture'

it('records a pick as intent and replays it at the next start (P2-16)', async () => {
  await restingChat()
  const fields = { key: 'model', value: 'gpt-picked' }
  const [picked] = await call('agentSession.setOption', {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
  expect(picked).toMatchObject({ ok: true, result: { ok: true } })
  expect(fixture.rig.store.getRecord(SESSION)?.options).toMatchObject({ model: 'gpt-picked' })
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()

  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  await fixture.rig.host.send(CALLER, restTestSend('use the new model', fence))
  await vi.waitFor(() => expect(fixture.rig.adapter.acquire).toHaveBeenCalledOnce())
  expect(fixture.rig.adapter.acquire.mock.calls[0]?.[0]).toMatchObject({
    options: expect.objectContaining({ model: 'gpt-picked' })
  })
})

it('answers the provider-level features of a chat at rest (P2-17)', async () => {
  await restingChat()
  setStructuredAgentSessionHost(await fixture.rig.restart({ agents: claudeAndCodexDeclared() }))
  Object.assign(fixture.rig.host.deps.adapter, {
    rewindSupport: (_id: string, agent?: string) =>
      agent === 'codex' ? { supported: true } : { supported: false, reason: 'unsupported' }
  })
  const [options] = await call('agentSession.options', { sessionId: SESSION })
  expect(options).toMatchObject({
    ok: true,
    result: { threadGoal: { current: null }, rewind: { supported: true } }
  })
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  expect(fixture.rig.adapter.readOptions).not.toHaveBeenCalled()
})

it('is shown, not respawned; the next send starts the agent (P2-18)', async () => {
  await foundRestTestChat(fixture.rig)
  const running = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.child!
  await fixture.rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    reason: 'killed',
    cause: 'unexpected-exit',
    fence: running.fence,
    acquisitionGeneration: running.generation!
  })
  // ast-grep-ignore: test-no-real-time-wait -- proves no respawn follows the exit; an absence has no condition to wait on.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(fixture.rig.adapter.acquire).toHaveBeenCalledOnce()

  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  expect(fixture.rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  await fixture.rig.host.send(CALLER, restTestSend('again', fence))
  await vi.waitFor(() => expect(fixture.rig.adapter.acquire).toHaveBeenCalledTimes(2))
})

it('whose settlement write failed is settled by the next send, which is delivered', async () => {
  await foundRestTestChat(fixture.rig)
  const open = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!
  const running = open.child!
  // A turn in flight, so the exit has something to settle.
  fixture.rig.adapter.acquire.mock.calls
    .at(-1)?.[0]
    .events?.appendItem(
      { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'working', ordinal: 50 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await fixture.rig.host.flushStreamedEvents(SESSION)
  // Refuse both the exit write and its queued retry to test retained death evidence.
  vi.spyOn(open.journal, 'appendLifecycleBatch')
    .mockRejectedValueOnce(new Error('disk full'))
    .mockRejectedValueOnce(new Error('disk full'))
  await fixture.rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    reason: 'killed',
    cause: 'unexpected-exit',
    fence: running.fence,
    acquisitionGeneration: running.generation!
  })
  // Released with its death evidence, not latched: the next acquire settles from that evidence.
  await vi.waitFor(() =>
    expect(fixture.rig.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed' }
    })
  )
  await fixture.rig.host.collaboratorsForTests().serialize(SESSION, async () => {})

  const sent = await fixture.rig.host.send(
    CALLER,
    restTestSend('again', fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence)
  )

  if (!sent.ok) {
    throw new Error(`send refused: ${sent.refusal.code}`)
  }
  await fixture.rig.host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
  expect(fixture.rig.adapter.dispatch).toHaveBeenCalledTimes(2)
  expect(
    activeStructuredAgentSessionTurnId((await fixture.rig.host.journalSnapshot(SESSION)).items)
  ).not.toBe('working')
})

it.each([
  ['the close RPC', async () => void (await call('agentSession.close', { sessionId: SESSION }))],
  ['the runtime chat close', async () => void (await closeStructuredAgentSessionChild(SESSION))],
  [
    'a discarded worker',
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the discard reads only this runtime member.
      discardStructuredWorkerSession(SESSION, {
        retireStructuredAgentSessionTabFromSnapshot: () => undefined
      } as never)
  ]
])('%s rejects a message accepted before any start, and starts nothing', async (_, close) => {
  await restingChat()
  const { loop } = fixture.rig.host.collaboratorsForTests().conversationDelivery
  vi.spyOn(loop, 'wake').mockImplementation(() => Promise.resolve())
  const reader: unknown[] = []
  await fixture.rig.host.subscribe({
    id: 'reader',
    sessionId: SESSION,
    emit: (event) => reader.push(event)
  })
  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  expect(
    (await fixture.rig.host.send(CALLER, restTestSend('closed before it went', fence))).ok
  ).toBe(true)

  await close()
  // A close's rejection is a sentence with its fact beside it, never a marker.
  await vi.waitFor(() =>
    expect(JSON.stringify(reader)).toContain(
      '"reason":"The chat closed before this message was sent.","submittedAt"'
    )
  )
  expect(JSON.stringify(reader)).toContain('"rejection":{"kind":"chatClosed"}')
  expect(fixture.rig.host.hasSession(SESSION)).toBe(false)
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
})
