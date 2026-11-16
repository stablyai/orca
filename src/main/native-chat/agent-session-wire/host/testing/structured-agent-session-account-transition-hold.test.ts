import { afterEach, expect, it, vi } from 'vitest'
import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import type { AgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import type { AgentChildWorkView } from '../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { reportedChildWork } from './structured-agent-session-host.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import { weekly } from './structured-agent-session-usage-limit-fleet.test-fixture'
import type { UsageLimitAccountScope } from '../../recovery/structured-agent-session-usage-limit-account-hold'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:worker', dispatchId: null, messages: [] }
}

/** A chat whose agent runs on account A; `switchTo` changes what its next start would use. */
async function chatOnAccountA() {
  let clock = HOST_TEST_NOW
  let home = '/homes/a'
  let openDispatch = false
  // Every account has room from the latest reading on.
  const room: UsageLimitAccountScope = {
    scope: 'any',
    account: { key: 'any', read: () => weekly(0, null, clock), refresh: () => true }
  }
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    restartable: true,
    acquiredAccountHome: () => ({ variable: 'CODEX_HOME', path: home }),
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      accountUsage: async () => room
    }
  })
  rig = current
  let accountReads = 0
  let onAccountRead: (() => void) | undefined
  current.host.deps.launchAccountHome = async () => {
    accountReads++
    const read = onAccountRead
    onAccountRead = undefined
    read?.()
    return { variable: 'CODEX_HOME', path: home }
  }
  current.host.deps.hasOpenDispatch = () => openDispatch
  // What the runtime fires when a Dispatch settles or the account selection changes.
  const releases = new Set<(edge: 'dispatch' | 'account') => void>()
  current.host.deps.accountMoveWakes = {
    subscribe: (wake) => {
      releases.add(wake)
      return () => releases.delete(wake)
    }
  }
  await eventually(() =>
    expect(current.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
  const child = () => current.host.collaboratorsForTests().sessions.get(SESSION)?.child
  const accountA = child()!.fence
  return {
    accountA,
    child,
    /** The agent's last turn hit a usage limit that resets a minute from now. */
    limited: async () => {
      await current.store.setSessionTabVisibility(SESSION, true)
      return appendRewindUsageLimitedTurn(
        current.host.collaboratorsForTests().sessions.get(SESSION)!.journal,
        clock
      )
    },
    nextQueued: async () => {
      const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
      return page.ok ? (page.page.nextQueuedMessageId ?? null) : 'refused'
    },
    hostSends: async () =>
      (
        await readTestJournalSnapshot(
          current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        )
      ).submissions.filter((submission) => submission.origin === 'host'),
    /** One automatic-continue pass, `ms` later. */
    sweep: async (ms: number) => {
      clock += ms
      await current.host.usageLimitContinue.tick()
    },
    switchTo: (path: string) => {
      home = path
    },
    /** The Dispatch settles in the orchestration store, with no write to this chat. */
    closeDispatch: () => {
      openDispatch = false
      releases.forEach((wake) => wake('dispatch'))
    },
    accountReads: () => accountReads,
    /** Runs once, inside the next read of the account a start would use. */
    onNextAccountRead: (run: () => void) => {
      onAccountRead = run
    },
    /** Orchestration changes that touch no Dispatch of this chat. */
    unrelatedDispatchChanges: (count: number) => {
      for (let i = 0; i < count; i++) {
        releases.forEach((wake) => wake('dispatch'))
      }
    },
    setOpenDispatch: (open: boolean) => {
      openDispatch = open
    },
    background: (views: AgentChildWorkView[]) => {
      clock += 1_000
      current.host.publishChildWorkEvidence(SESSION, reportedChildWork(views, clock))
    },
    /** Every dispatch of `text`, by the fence of the child that took it. */
    dispatchedTo: (text: string) =>
      current.dispatch.mock.calls
        .filter(([input]) => JSON.stringify(input.body.blocks).includes(text))
        .map(([input]) => input.fence)
  }
}

function devServer(overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'child-dev',
    providerId: 'task-dev',
    kind: 'command',
    description: 'npm run dev',
    state: 'working',
    membership: 'live',
    firstObservedAt: HOST_TEST_NOW,
    observedAt: HOST_TEST_NOW,
    stoppable: true,
    invocation: { invocationId: 'spawn-dev', generation: 1 },
    ...overrides
  }
}

it('holds a send behind a background command, then delivers it once on the new account', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('next step')
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(chat.dispatchedTo('next step')).toEqual([])
  // The queue names no card it will not send, so the chat does not read as working.
  expect(await chat.nextQueued()).toBeNull()

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])

  await eventually(async () => expect((await rig!.handoff(sent.id))?.handedOverAt).toBeDefined())
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
  expect(chat.dispatchedTo('next step')).toEqual([chat.child()!.fence])
  expect(chat.child()!.fence).not.toBe(chat.accountA)
  expect(rig!.starts).toHaveBeenCalledTimes(2)
})

it("lets a worker's mail reach its open dispatch past a held send, then moves accounts", async () => {
  const chat = await chatOnAccountA()
  chat.setOpenDispatch(true)
  chat.switchTo('/homes/b')
  const person = rig!.send('a new task for you')
  await person.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: person.id, state: 'waiting' }])
  )

  const mail = rig!.send('coordinator reply', undefined, { internal: true, from: MAIL })
  await mail.result
  // The reply the dispatch waits on goes to the agent still holding it, on A.
  await eventually(() => expect(chat.dispatchedTo('coordinator reply')).toEqual([chat.accountA]))
  expect(chat.dispatchedTo('a new task for you')).toEqual([])
  const mailSend = await rig!.handoffId(mail.id)
  await rig!.settleAccepted(mailSend, 'reply')

  chat.closeDispatch()
  await eventually(() => expect(chat.dispatchedTo('a new task for you')).toHaveLength(1))
  expect(chat.dispatchedTo('a new task for you')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
  expect(chat.dispatchedTo('coordinator reply')).toEqual([chat.accountA])
})

it('keeps a held send through Stop, and Resume delivers it once on the new account', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('after the switch')
  await sent.result
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(await rig!.stop()).toMatchObject({ ok: true })
  await eventually(() => expect(chat.child()).toBeNull())
  expect((await rig!.drafts()).map(({ messageId }) => messageId)).toEqual([sent.id])
  expect(await rig!.queuePause()).toEqual({ reason: 'stopped' })
  expect(chat.dispatchedTo('after the switch')).toEqual([])
  expect(await rig!.resume()).toMatchObject({ ok: true })
  await eventually(() => expect(chat.dispatchedTo('after the switch')).toHaveLength(1))
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('sends no usage-limit continue to the old account while its subagent still runs', async () => {
  const chat = await chatOnAccountA()
  const subagent = devServer({ id: 'child-agent', providerId: 'task-agent', kind: 'agent' })
  chat.background([subagent])
  await chat.limited()
  chat.switchTo('/homes/b')
  await chat.sweep(15_000)
  await chat.sweep(15_000)
  // Not even admitted: a continue accepted now would only wait for, or reach, the agent on A.
  expect(await chat.hostSends()).toEqual([])
  expect(await rig!.drafts()).toEqual([])

  chat.background([{ ...subagent, membership: 'settled', state: 'done', outcome: 'succeeded' }])
  await chat.sweep(15_000)
  await eventually(() => expect(chat.dispatchedTo('Continue where you left off')).toHaveLength(1))
  expect(chat.dispatchedTo('Continue where you left off')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})

it('lets go of the hold once the person deletes the message it held', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  const sent = rig!.send('never mind')
  await sent.result
  const session = () => rig!.host.collaboratorsForTests().sessions.get(SESSION)
  await eventually(() => expect(session()?.awaitsAccountMove).toBe(true))
  expect(await rig!.deleteQueued(sent.id)).toMatchObject({ ok: true })
  await eventually(() => expect(session()?.awaitsAccountMove).toBeUndefined())
  expect(chat.dispatchedTo('never mind')).toEqual([])
})

it('wakes a chat held on child work for none of 10 or 100 unrelated Dispatch changes', async () => {
  const chat = await chatOnAccountA()
  chat.background([devServer()])
  chat.switchTo('/homes/b')
  await rig!.send('held').result
  const host = rig!.host.collaboratorsForTests()
  await eventually(() => expect(host.sessions.get(SESSION)?.awaitsAccountMove).toBe(true))
  const wake = vi.spyOn(host.conversationDelivery.loop, 'wake')
  const reads = chat.accountReads()

  chat.unrelatedDispatchChanges(10)
  expect(wake).not.toHaveBeenCalled()
  chat.unrelatedDispatchChanges(100)
  expect(wake).not.toHaveBeenCalled()
  expect(chat.accountReads()).toBe(reads)
  expect(chat.dispatchedTo('held')).toEqual([])
})

it('takes a send back from the old account when its work shows up only after the send was accepted', async () => {
  const chat = await chatOnAccountA()
  chat.switchTo('/homes/b')
  // The agent reports a background command after the send is accepted, before it is handed over.
  chat.onNextAccountRead(() => chat.background([devServer()]))
  const sent = rig!.send('raced')
  expect(await sent.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig!.drafts()).toEqual([{ messageId: sent.id, state: 'waiting' }])
  )
  expect(chat.dispatchedTo('raced')).toEqual([])
  // Its accepted copy is answered by the card, so the chat shows it once.
  expect((await rig!.submission(sent.id))?.keptAsQueuedMessageId).toBe(sent.id)

  const mail = rig!.send('mail meanwhile', undefined, { internal: true, from: MAIL })
  await mail.result
  await eventually(() => expect(chat.dispatchedTo('mail meanwhile')).toEqual([chat.accountA]))
  await rig!.settleAccepted(await rig!.handoffId(mail.id), 'mail meanwhile')

  chat.background([devServer({ membership: 'settled', state: 'done', outcome: 'succeeded' })])
  await eventually(() => expect(chat.dispatchedTo('raced')).toHaveLength(1))
  expect(chat.dispatchedTo('raced')).toEqual([chat.child()!.fence])
  expect(chat.child()?.accountHome).toEqual({ variable: 'CODEX_HOME', path: '/homes/b' })
})
