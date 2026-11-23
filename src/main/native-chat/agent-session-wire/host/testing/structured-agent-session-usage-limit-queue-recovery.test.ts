import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { usageLimitAccountSources } from '../../../../runtime/agent-session/installation/usage-limit-account-usage'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

const RESET = NOW + 60_000
let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

function reading(usedPercent: number, updatedAt: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: { usedPercent, windowMinutes: 10_080, resetsAt: RESET, resetDescription: null },
    updatedAt,
    error: null,
    status: 'ok'
  }
}

async function relaunchedChat(reset: number | null = RESET) {
  let clock = NOW
  let homePath = join(tmpdir(), 'orca-usage-fixture', 'a')
  const nextHome = join(tmpdir(), 'orca-usage-fixture', 'b')
  const readingSource = { home: nextHome, provenance: 'fixture' }
  const settings = {}
  let limits: ProviderRateLimits | null = null
  const requested: unknown[] = []
  const accountHome = () => ({ variable: 'CODEX_HOME' as const, path: homePath })
  const sources = usageLimitAccountSources({
    rateLimits: () => ({
      usageReadingAccount: () => (limits ? readingSource : null),
      usageReading: () => limits,
      requestUsageReading: (_provider, options) => {
        requested.push(options)
        return true
      }
    }),
    settings: () => settings,
    shellEnvironment: async () => ({}),
    shellEnvironmentRevision: () => 1,
    claudeLaunchEnv: () => ({}),
    processEnvironment: {}
  })
  const current = await createQueuedMessageTestRig({
    now: () => clock,
    restartable: true,
    acquiredAccountHome: accountHome,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      ...sources
    }
  })
  rig = current
  const { host, store } = current
  host.deps.launchAccountHome = async () => accountHome()
  const fence = () => store.getRecord(SESSION)!.lease.runtimeFence
  const attach = (expectedFence: number) =>
    host.attach(QUEUED_RIG_CALLER, hostTestAttachParams(expectedFence))
  const ready = () =>
    eventually(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
  await ready()
  await store.setSessionTabVisibility(SESSION, true)
  const journal = (await host.conversation(SESSION)).journal
  const cutFence = fence()
  const turn = { provider: 'orca' as const, clientMessageId: 'usage-limited' }
  const turnItemId = agentJournalItemKey(turn)
  await journal.appendItem(
    turn,
    {
      kind: 'turn',
      turnId: 'usage-limited',
      providerTurnId: 'usage-limited',
      state: 'completed',
      outcome: 'failure',
      startedAt: NOW,
      completedAt: NOW
    },
    { fence: cutFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          usageLimit: reset === null ? {} : { resetsAt: reset }
        }),
        { surface: 'row' }
      )
    },
    { fence: cutFence, turnScope: { kind: 'turn', turnItemId } }
  )

  const rest = () => {
    const { lifetime } = host.collaboratorsForTests()
    return host.serialize(SESSION, () =>
      lifetime.stopAgent(SESSION, { cause: 'evict', resting: true })
    )
  }
  const relaunch = async () => {
    const previous = fence()
    await rest()
    expect(await attach(fence())).toMatchObject({ ok: true })
    await ready()
    expect(store.getRecord(SESSION)?.launchedAccount).toEqual({
      fence: fence(),
      accountHome: accountHome()
    })
    expect(fence()).toBeGreaterThan(previous)
  }

  homePath = nextHome
  await relaunch()
  expect(await journal.reads.usageLimitCut()).toMatchObject({
    fence: cutFence,
    ...(reset === null ? {} : { resetsAt: reset })
  })

  return {
    current,
    fence,
    host,
    journal,
    relaunch,
    rest,
    requested,
    pass: async (offset: number, next: ProviderRateLimits | null) => {
      clock = NOW + offset
      limits = next
      await host.usageLimitContinue.tick()
      return (await journal.reads.pendingSubmissions()).filter(({ origin }) => origin === 'host')
    }
  }
}

it('resumes on fresh quota after a relaunch and delivers the mail held behind the failed turn', async () => {
  const { current, fence, journal, pass, rest } = await relaunchedChat()
  const mail = await current.send('check the build', 'queue-if-active', {
    internal: true,
    from: { kind: 'agent', senders: [], orchestration: null }
  }).result
  if (!mail.ok || !('queued' in mail.value)) {
    throw new Error('Expected mail to queue behind the failed turn')
  }
  const card = mail.value.queued.messageId
  expect(await current.queuePause()).toEqual({ reason: 'failed' })
  await rest()
  expect(await pass(5_000, reading(0, NOW + 5_000))).toEqual([])
  const sent = await pass(20_000, reading(0, NOW + 20_000))
  expect(sent).toHaveLength(1)
  const id = sent[0]!.clientMessageId
  await eventually(async () => expect((await current.submission(id))?.handedOverAt).toBeDefined())
  expect(await current.handoff(card)).toBeUndefined()
  await current.settleAccepted(id, 'continued')
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'completed-continue', ordinal: 0 },
    {
      kind: 'turn',
      turnId: 'completed-continue',
      userItemId: agentJournalSubmissionKey(id),
      state: 'completed',
      outcome: 'success',
      startedAt: NOW + 20_000,
      completedAt: NOW + 20_000
    },
    { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await eventually(async () => expect((await current.handoff(card))?.handedOverAt).toBeDefined())
})

it('discards stale quota when the chat relaunches while its account is being resolved', async () => {
  const { host, pass, relaunch } = await relaunchedChat()
  const stale = reading(0, NOW + 5_000)
  expect(await pass(5_000, stale)).toEqual([])
  const resolve = host.deps.launchAccountHome!
  host.deps.launchAccountHome = async (...args) => {
    host.deps.launchAccountHome = resolve
    await relaunch()
    return resolve(...args)
  }
  expect(await pass(20_000, stale)).toEqual([])
  expect(await pass(25_000, stale)).toEqual([])
  expect(await pass(30_000, reading(0, NOW + 30_000))).toEqual([])
  expect(await pass(45_000, reading(0, NOW + 45_000))).toHaveLength(1)
})

it('discards stale quota when the chat relaunches before the retry is admitted', async () => {
  const { host, pass, relaunch } = await relaunchedChat()
  const stale = reading(0, NOW + 5_000)
  expect(await pass(5_000, stale)).toEqual([])
  const send = host.send
  host.send = async (...args) => {
    host.send = send
    await relaunch()
    return send(...args)
  }
  expect(await pass(20_000, stale)).toEqual([])
  expect(await pass(25_000, reading(0, NOW + 25_000))).toEqual([])
  expect(await host.readUsageLimitContinue(SESSION)).toMatchObject({ continueAt: NOW + 25_000 })
})

it('holds a retry when the account is exhausted without waking an idle reading', async () => {
  const { pass, requested } = await relaunchedChat()
  expect(await pass(5_000, null)).toEqual([])
  expect(requested).toEqual([])
  expect(await pass(20_000, reading(100, NOW + 20_000))).toEqual([])
  expect(await pass(45_000, reading(100, NOW + 45_000))).toEqual([])
})

it('requires fresh room before a resetless relaunched cut continues', async () => {
  const { pass } = await relaunchedChat(null)
  expect(await pass(5_000, null)).toEqual([])
  expect(
    await pass(20_000, { ...reading(0, NOW + 20_000), status: 'error', error: 'offline' })
  ).toEqual([])
  expect(await pass(35_000, reading(0, NOW - 1))).toEqual([])
  expect(await pass(50_000, { ...reading(0, NOW + 50_000), weekly: null })).toEqual([])
  expect(await pass(65_000, reading(0, NOW + 65_000))).toHaveLength(1)
})
