import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
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
import { openHostRig, message, stop } from './acp-structured-host.test-support'
import { waitFor } from './acp-structured-adapter.test-support'

const opened: Awaited<ReturnType<typeof openHostRig>>[] = []

async function fixture() {
  const spec = acpLaunchSpecFor('omp')
  if (!spec) {
    throw new Error('OMP launch spec missing')
  }
  let busy = true
  const rig = await openHostRig({
    spec,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        if (busy) {
          agent.fail(frame, -32003, 'Agent is already processing.', { reason: 'session_busy' })
        } else {
          agent.reply(frame, { stopReason: 'end_turn' })
        }
      })
  })
  opened.push(rig)
  const attach = (fence: number | null) =>
    hostTestAttachParams(fence, {
      provider: 'omp',
      agent: 'omp',
      providerHandle: undefined,
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/accounts/omp' }
    })
  expect(await rig.host.attach(CALLER, attach(null))).toMatchObject({ ok: true })
  await rig.ready()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const params = (text: string) => {
    const fields = { body: message(text), delivery: 'queue-if-active' as const }
    return { envelope: envelope('agentSession.send', fields), ...fields, userSend: true as const }
  }
  const rows = async () => {
    await rig.host.flushStreamedEvents(SESSION)
    return (await rig.host.history({ sessionId: SESSION, direction: 'tail' })).page.items
  }
  return {
    ...rig,
    params,
    rows,
    attach,
    idle: () => {
      busy = false
    }
  }
}

afterEach(async () => {
  for (const rig of opened.splice(0)) {
    await rig.rig.adapter.forceCloseSession(SESSION)
  }
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

describe('busy ACP prompts through the durable session host', () => {
  it('keeps later messages in the existing queue and delivers each logical message once', async () => {
    const rig = await fixture()
    const first = rig.params('first')
    expect(await rig.host.send(CALLER, first)).toMatchObject({ ok: true })
    await rig.rig.frame('session/prompt')
    expect(await rig.host.send(CALLER, first)).toMatchObject({ ok: true, replayed: true })
    expect(await rig.host.send(CALLER, rig.params('second'))).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    await vi.advanceTimersByTimeAsync(7000)
    expect(rig.rig.sent('session/prompt')).toHaveLength(4)
    expect(
      (await rig.rows()).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
    rig.idle()
    await vi.advanceTimersByTimeAsync(5000)
    await waitFor(() => expect(rig.rig.sent('session/prompt')).toHaveLength(6))
    await waitFor(async () => {
      const turns = (await rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns).toMatchObject([
        { state: 'completed', outcome: 'success' },
        { state: 'completed', outcome: 'success' }
      ])
    })
    expect(await rig.messages()).toEqual(['first', 'second'])
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.submissions).toHaveLength(2)
    expect(snapshot.submissions.every((row) => row.dispatchState === 'accepted')).toBe(true)
    expect(
      (await rig.host.history({ sessionId: SESSION, direction: 'tail' })).page.queuedMessages ?? []
    ).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.rig.sent('session/prompt')).toHaveLength(6)
  })

  it('Stop interrupts the pending send and leaves later queued text for the user', async () => {
    const rig = await fixture()
    await rig.host.send(CALLER, rig.params('stop this pending send'))
    await rig.rig.frame('session/prompt')
    await rig.host.send(CALLER, rig.params('keep this queued draft'))
    await stop(rig.host)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.rig.sent('session/prompt')).toHaveLength(1)
    expect(await rig.messages()).toEqual(['stop this pending send'])
    const turns = (await rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns).toMatchObject([{ state: 'interrupted' }])
    const history = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.page.queuedMessages).toMatchObject([
      { state: 'waiting', body: message('keep this queued draft') }
    ])
    expect(
      (await rig.rows()).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
  })

  it('keeps the message after close and does not replay it when the session is reopened', async () => {
    const rig = await fixture()
    await rig.host.send(CALLER, rig.params('retain across close'))
    await rig.rig.frame('session/prompt')
    const oldChild = rig.rig.child()
    await rig.host.close(SESSION, 'user-close')
    rig.idle()
    expect(await rig.host.attach(CALLER, rig.attach(rig.fence()))).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(oldChild.agent.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(
      1
    )
    expect(await rig.messages()).toEqual(['retain across close'])
    expect(
      (await rig.rows()).filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toEqual([])
  })
})
