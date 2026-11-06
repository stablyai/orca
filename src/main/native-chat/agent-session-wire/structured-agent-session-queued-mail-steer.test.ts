import { journalToolPayload } from '../agent-session-journal/journal-payload-bounds'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { admitStructuredAgentSessionInput } from './structured-agent-session-input-admission'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())
const from: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'run:coordinator',
    dispatchId: null,
    messages: [{ messageId: 'report', runId: 'coordinator', from: 'term_worker' }]
  }
}

async function prompt(state: 'pending' | 'resolved') {
  const journal = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'approval' },
    {
      kind: 'approval',
      title: 'Allow the tool?',
      detail: null,
      options: [],
      resolution: {
        state,
        selectedOptionId: state === 'resolved' ? 'allow' : null,
        resolvedBy: state === 'resolved' ? 'person' : null,
        resolvedAt: state === 'resolved' ? 1 : null
      }
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

async function active(agent: 'claude' | 'codex') {
  rig = await createQueuedMessageTestRig({
    restartable: true,
    ...(agent === 'claude' ? { agent } : {})
  })
  rig.host.deps.adapter.readAppliedInputOptions = ({ next }) => ({
    active: next ?? {},
    next: next ?? {}
  })
  const id = await rig.workingSend()
  await rig.settleAccepted(id, 'original')
  await openRigTurnFor(rig, id)
  return id
}

const mail = () => rig!.send('worker report', 'queue-if-active', { internal: true, from })

describe.each(['claude', 'codex'] as const)('%s automatic mail steering', (agent) => {
  it('passes an ordinary follow-up during a turn, retaining the follow-up', async () => {
    await active(agent)
    const person = rig!.send('next request', 'queue-if-active')
    await person.result
    const report = mail()
    expect(await report.result).toMatchObject({
      ok: true,
      value: { queued: { messageId: report.id } }
    })
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(rig!.dispatch.mock.calls[1]![0].body.blocks).toEqual([
      { type: 'text', text: 'worker report' }
    ])
    expect(await rig!.drafts()).toMatchObject([{ messageId: person.id }])
    expect(await rig!.handoff(report.id)).toBeDefined()
    expect(await rig!.handoff(person.id)).toBeUndefined()
  })

  it('retains Task briefs and mail behind them until the turn ends', async () => {
    const working = await active(agent)
    const task = rig!.send('new task', 'queue-if-active', {
      internal: true,
      from: {
        ...from,
        orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
      }
    })
    await task.result
    const report = mail()
    await report.result
    expect(await rig!.drafts()).toMatchObject([{ messageId: task.id }, { messageId: report.id }])
    expect(rig!.dispatch).toHaveBeenCalledTimes(1)
    await openRigTurnFor(rig!, working, 'completed')
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(rig!.dispatch.mock.calls[1]![0].body.blocks).toEqual([
      { type: 'text', text: 'new task' }
    ])
  })

  it('retains mail for a prompt, then joins the same turn when answered', async () => {
    await active(agent)
    await prompt('pending')
    const report = mail()
    await report.result
    expect(await rig!.drafts()).toMatchObject([{ messageId: report.id }])
    expect(rig!.dispatch).toHaveBeenCalledTimes(1)
    await prompt('resolved')
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
    expect(rig!.host.currentWork(SESSION)?.activeTurnId()).not.toBeNull()
    expect(await rig!.drafts()).toEqual([])
  })

  it.each(['prompt', 'Stop', 'failure'])(
    'honors %s arriving after consume before the provider handoff',
    async (barrier) => {
      const working = await active(agent)
      const { runtimeState, conversationDelivery } = rig!.host.collaboratorsForTests()
      const place = runtimeState.deliveryOrder.reserve(SESSION)
      try {
        const report = mail()
        await report.result
        await eventually(async () => expect(await rig!.handoff(report.id)).toBeDefined())
        if (barrier === 'Stop') {
          const stopped = rig!.stop()
          place.release()
          await stopped
          expect(rig!.dispatch).toHaveBeenCalledTimes(1)
          expect(await rig!.drafts()).toMatchObject([{ messageId: report.id, state: 'waiting' }])
          expect(await rig!.queuePause()).toEqual({ reason: 'stopped' })
          return
        }
        if (barrier === 'failure') {
          await openRigTurnFor(rig!, working, 'completed', 'failure')
          place.release()
          await conversationDelivery.loop.wake(SESSION)
          expect(rig!.dispatch).toHaveBeenCalledTimes(1)
          expect(await rig!.drafts()).toMatchObject([{ messageId: report.id, state: 'waiting' }])
          expect(await rig!.queuePause()).toEqual({ reason: 'failed' })
          expect(await rig!.host.sendAnswer(SESSION, report.id)).toEqual({ kind: 'waiting' })
          expect(await rig!.resume()).toMatchObject({ ok: true, value: { resumed: true } })
          await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
          expect(await rig!.drafts()).toEqual([])
          return
        }
        await prompt('pending')
        place.release()
        await conversationDelivery.loop.wake(SESSION)
        expect(rig!.dispatch).toHaveBeenCalledTimes(1)
        await prompt('resolved')
        await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
      } finally {
        place.release()
      }
    }
  )

  it.each(
    (['prompt', 'failure'] as const).flatMap((barrier) =>
      (['preparation', 'continuation'] as const).map((phase) => ({ barrier, phase }))
    )
  )(
    'restores mail when $barrier arrives during $phase, then delivers once released',
    async ({ barrier, phase }) => {
      const working = await active(agent)
      const preparing = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writes = vi.fn()
      let transitioning = phase === 'continuation'
      if (transitioning) {
        rig!.host.deps.adapter.permissionModeRequiresAcquisition = () => transitioning
        rig!.host.deps.adapter.settlePermissionTransition = async () => {
          preparing.resolve()
          await release.promise
          transitioning = false
          return true
        }
      }
      rig!.dispatch.mockImplementation(async ({ admitFreshInput }) => {
        if (phase === 'preparation') {
          preparing.resolve()
          await release.promise
        }
        await admitStructuredAgentSessionInput(admitFreshInput, writes)
        return { state: 'admitted' }
      })
      const report = mail()
      try {
        await report.result
        await preparing.promise
        await (barrier === 'failure'
          ? openRigTurnFor(rig!, working, 'completed', 'failure')
          : prompt('pending'))
        release.resolve()
        await eventually(async () =>
          expect(await rig!.drafts()).toMatchObject([{ messageId: report.id, state: 'waiting' }])
        )
        expect(writes).not.toHaveBeenCalled()
        expect(await rig!.host.sendAnswer(SESSION, report.id)).toEqual({ kind: 'waiting' })
        if (barrier === 'failure') {
          expect(await rig!.queuePause()).toEqual({ reason: 'failed' })
          expect(await rig!.resume()).toMatchObject({ ok: true, value: { resumed: true } })
        } else {
          await prompt('resolved')
        }
        await eventually(() => expect(writes).toHaveBeenCalledTimes(1))
        expect(await rig!.drafts()).toEqual([])
      } finally {
        release.resolve()
      }
    }
  )
})

it('keeps mail visible until the child can accept the applied turn options', async () => {
  await active('codex')
  const child = rig!.host.collaboratorsForTests().sessions.get(SESSION)!.child!
  child.phase = 'starting'
  const report = mail()
  await report.result
  expect(await rig!.drafts()).toMatchObject([{ messageId: report.id }])
  expect(await rig!.handoff(report.id)).toBeUndefined()
  child.phase = 'ready'
  rig!.host.deps.adapter.readAppliedInputOptions = () => ({
    active: { model: 'gpt-6.1-sol' },
    next: { model: 'gpt-6-astra' }
  })
  rig!.host.wakeQueuedMessages(SESSION)
  expect(await rig!.drafts()).toMatchObject([{ messageId: report.id }])
  expect(await rig!.handoff(report.id)).toBeUndefined()
  rig!.host.deps.adapter.readAppliedInputOptions = ({ next }) => ({
    active: next ?? {},
    next: next ?? {}
  })
  rig!.host.wakeQueuedMessages(SESSION)
  await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
})

it.each(
  [20, 200].flatMap((frames) =>
    (['assistant', 'reasoning', 'tool'] as const).map((kind) => ({ frames, kind }))
  )
)(
  'does not recheck held mail authority during $frames streamed $kind frames',
  async ({ frames, kind }) => {
    await active('codex')
    const authority = vi.fn<() => 'unavailable' | 'owed'>(() => 'unavailable')
    rig!.host.deps.queuedAgentMessageOwed = authority
    const report = mail()
    await report.result
    const { sessions, serialize } = rig!.host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const write = (text: string) =>
      journal.appendItem(
        { provider: 'orca', clientMessageId: 'streamed-reply' },
        kind === 'tool'
          ? {
              kind: 'tool-call',
              name: 'Bash',
              input: { command: 'git status' },
              state: 'running',
              output: journalToolPayload(text, true)
            }
          : {
              kind: 'message',
              role: kind,
              blocks: [{ type: 'text', text }],
              ...(kind === 'reasoning' ? { state: 'running' as const } : {})
            },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await write('start')
    await serialize(SESSION, async () => {})
    authority.mockClear()

    for (let frame = 0; frame < frames; frame += 1) {
      await write(String(frame))
      await serialize(SESSION, async () => {})
    }
    expect(authority).not.toHaveBeenCalled()
    expect(await rig!.handoff(report.id)).toBeUndefined()
    authority.mockReturnValue('owed')
    rig!.host.wakeQueuedMessages(SESSION)
    await eventually(() => expect(rig!.dispatch).toHaveBeenCalledTimes(2))
  }
)
