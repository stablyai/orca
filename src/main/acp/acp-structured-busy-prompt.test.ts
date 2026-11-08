import { afterEach, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { CancelParams } from '../../shared/rpc-contract/structured-agent-session-params'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { message, openHostRig, stop } from './acp-structured-host.test-support'

let opened: Awaited<ReturnType<typeof openHostRig>> | undefined

async function fixture() {
  const spec = acpLaunchSpecFor('omp')
  if (!spec) {
    throw new Error('OMP launch spec missing')
  }
  opened = await openHostRig({ spec })
  const { rig, host } = opened
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'omp',
        agent: 'omp',
        providerHandle: undefined,
        accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/accounts/omp' }
      })
    )
  ).toMatchObject({ ok: true })
  await opened.ready()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const send = (text: string) => {
    const fields = { body: message(text), delivery: 'queue-if-active' as const }
    return host.send(CALLER, { envelope: envelope('agentSession.send', fields), ...fields })
  }
  rig.child().agent.on('session/prompt', (frame) =>
    rig.child().agent.fail(frame, -32003, 'Agent is already processing.', {
      reason: 'session_busy'
    })
  )
  return { ...opened, send }
}

afterEach(async () => {
  await opened?.rig.adapter.forceCloseSession(SESSION)
  opened = undefined
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

it('retains the first refused OMP message while later messages queue and complete in order', async () => {
  const { rig, host, send, messages } = await fixture()
  expect(await send('first')).toMatchObject({ ok: true })
  await rig.frame('session/prompt')
  await rig.settle()
  expect(await send('second')).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
  expect(await send('third')).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
  await vi.advanceTimersByTimeAsync(7_000)
  expect(rig.sent('session/prompt')).toHaveLength(4)
  rig
    .child()
    .agent.on('session/prompt', (frame) =>
      rig.child().agent.reply(frame, { stopReason: 'end_turn' })
    )
  await vi.advanceTimersByTimeAsync(5_000)
  await waitFor(() => expect(rig.sent('session/prompt')).toHaveLength(7))
  await waitFor(async () => {
    await host.flushStreamedEvents(SESSION)
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.page.items.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toMatchObject(
      [
        { state: 'completed', outcome: 'success' },
        { state: 'completed', outcome: 'success' },
        { state: 'completed', outcome: 'success' }
      ]
    )
    expect(history.page.queuedMessages ?? []).toEqual([])
    expect(
      history.page.items.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
  })
  expect(await messages()).toEqual(['first', 'second', 'third'])
  const snapshot = await host.journalSnapshot(SESSION)
  expect(snapshot.submissions).toHaveLength(3)
  expect(snapshot.submissions.every((row) => row.dispatchState === 'accepted')).toBe(true)
})

it.each(['Stop', 'close'] as const)(
  '%s cancels busy recovery and preserves later queued text',
  async (action) => {
    const { rig, host, send, messages } = await fixture()
    await send('first')
    await rig.frame('session/prompt')
    await rig.settle()
    await send('queued')
    const child = rig.child()
    await (action === 'Stop' ? stop(host) : host.close(SESSION, 'user-close'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(child.agent.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(1)
    expect(await messages()).toEqual(['first'])
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.page.queuedMessages).toMatchObject([
      { state: 'waiting', body: message('queued') }
    ])
    expect(history.page.items.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toMatchObject(
      [{ state: 'interrupted' }]
    )
  }
)

const ownPermission = (toolCallId: string) => ({
  sessionId: PROVIDER_SESSION,
  toolCall: { toolCallId, title: 'orca worktree set --unread' },
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
})

async function pendingCard(host: Awaited<ReturnType<typeof fixture>>['host']) {
  return waitFor(async () => {
    await host.flushStreamedEvents(SESSION)
    const found = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items.find(
      (row) => row.body.kind === 'approval'
    )
    expect(found?.body).toMatchObject({ resolution: { state: 'pending' } })
    return found!
  })
}

it('keeps OMP own permission answerable after the held message fails', async () => {
  const { rig, host, send, fence } = await fixture()
  await send('first')
  await rig.frame('session/prompt')
  await rig.settle()
  const { agent } = rig.child()
  const asked = agent.request('own-turn', 'session/request_permission', ownPermission('own-call'))
  const card = await pendingCard(host)
  agent.on('session/prompt', (frame) => agent.fail(frame, -32603, 'model unavailable'))
  await vi.advanceTimersByTimeAsync(1_000)
  await waitFor(async () => {
    await host.flushStreamedEvents(SESSION)
    const turns = (
      await host.history({ sessionId: SESSION, direction: 'tail' })
    ).page.items.flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns).toMatchObject([{ state: 'completed' }])
  })
  expect((await pendingCard(host)).itemId).toBe(card.itemId)
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: card.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId: 'allow' },
    fence: fence(),
    commit: async () => {}
  })
  expect(await asked).toMatchObject({
    result: { outcome: { outcome: 'selected', optionId: 'allow' } }
  })
})

it('Cancel on a card from OMP own work, with no message running, cancels that request', async () => {
  const { rig, host } = await fixture()
  const asked = rig
    .child()
    .agent.request('own-cancel', 'session/request_permission', ownPermission('own-cancel'))
  const card = await pendingCard(host)
  const fields = { prompt: { itemId: card.itemId, expectedRevision: card.revision } }
  // Clients send exactly this over RPC, so it must pass the wire schema.
  const params = CancelParams.parse({
    envelope: envelope('agentSession.cancel', fields),
    ...fields
  })
  expect(await host.cancel(CALLER, params)).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await asked).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
})
