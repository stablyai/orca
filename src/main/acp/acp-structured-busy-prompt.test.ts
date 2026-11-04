import { afterEach, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { waitFor } from './acp-structured-adapter.test-support'
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
