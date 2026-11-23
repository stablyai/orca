// A chat on account A whose next start can be switched, shared by the account-transition hold tests.
import { expect } from 'vitest'
import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
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
import type { StructuredAgentSessionAccountMoveEdge } from '../structured-agent-session-host-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data.test-fixture'

/** The rig the last `chatOnAccountA` started; each test file disposes it after each test. */
export let rig: QueuedMessageTestRig | undefined

export const MAIL: AgentMessageSource = {
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
export async function chatOnAccountA() {
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
  let onAccountRead: { at: number; run: () => void } | undefined
  let switchDuringRead: { at: number; path: string } | undefined
  current.host.deps.launchAccountHome = async () => {
    accountReads++
    const seen = home
    if (switchDuringRead?.at === accountReads) {
      const { path } = switchDuringRead
      switchDuringRead = undefined
      home = path
      releases.forEach((wake) => wake({ kind: 'account' }))
      return { variable: 'CODEX_HOME', path: seen }
    }
    if (onAccountRead?.at === accountReads) {
      const { run } = onAccountRead
      onAccountRead = undefined
      run()
    }
    return { variable: 'CODEX_HOME', path: home }
  }
  let dispatchReads = 0
  current.host.deps.hasOpenDispatch = () => {
    dispatchReads++
    return openDispatch
  }
  // What the runtime fires when a Dispatch settles or the account selection changes.
  const releases = new Set<(edge: StructuredAgentSessionAccountMoveEdge) => void>()
  current.host.deps.accountMoveWakes = {
    subscribe: (wake) => {
      releases.add(wake)
      return () => releases.delete(wake)
    },
    selection: () => [home],
    dispatchKey: (sessionId) => `structured:${sessionId}`
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
    /** The selection changes: what a start would use, and the edge settings fire for it. */
    switchTo: (path: string) => {
      home = path
      releases.forEach((wake) => wake({ kind: 'account' }))
    },
    /** The selection changes with no edge, as when a removed account is pruned from it. */
    switchSilentlyTo: (path: string) => {
      home = path
    },
    /** The Dispatch settles in the orchestration store, with no write to this chat. */
    closeDispatch: () => {
      openDispatch = false
      releases.forEach((wake) => wake({ kind: 'dispatch', ended: [`structured:${SESSION}`] }))
    },
    accountReads: () => accountReads,
    /** The person switches to `path` while the next account read is under way: that read still
     *  returns the selection it saw. */
    switchDuringNextAccountRead: (path: string) => {
      switchDuringRead = { at: accountReads + 1, path }
    },
    dispatchReads: () => dispatchReads,
    /** Runs once, inside the handover's read of the account a start would use: the read after
     *  the send's admission. */
    onHandoverAccountRead: (run: () => void) => {
      onAccountRead = { at: accountReads + 2, run }
    },
    /** Orchestration changes that touch no Dispatch of this chat. */
    unrelatedDispatchChanges: (count: number) => {
      for (let i = 0; i < count; i++) {
        releases.forEach((wake) => wake({ kind: 'dispatch', ended: [`structured:other-${i}`] }))
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
        .map(([input]) => input.fence),
    /** Every mail dispatch, by fence: the agent is sent a pointer, not the mail's words. */
    mailDispatchedTo: () =>
      current.dispatch.mock.calls
        .filter(([input]) => input.body.from?.orchestration?.message === 'mail-notice')
        .map(([input]) => input.fence)
  }
}

export function devServer(overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
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
