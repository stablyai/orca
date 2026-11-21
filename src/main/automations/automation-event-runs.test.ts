import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNowSettled } from './testing/automation-run-now-settled.test-fixture'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'
import { createBotAutomationDispatcher, type BotRunThreads } from './bot-automation-launch'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  fakeResults,
  fakeSessions,
  seedBot,
  seedBotAutomation
} from './bot-automation.test-fixture'
import { MISSED_RUN } from './dispatch/dispatch-refusal'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const MENTIONED: AutomationEventTrigger = { id: 't1', source: 'slack', event: 'mentioned' }

function slackEvent(overrides: Partial<AutomationRunEvent> = {}): AutomationRunEvent {
  return {
    triggerId: 't1',
    source: 'slack',
    event: 'mentioned',
    key: 'T1:C1:1700.01',
    subject: 'T1:C1:1700.01',
    occurredAt: Date.now(),
    actor: 'Dana Lee',
    place: '#infra',
    text: '@Alice can you look at why deploys are failing?',
    ...overrides
  }
}

function setup(store: Store, options: { paused?: boolean } = {}) {
  const bot = seedBot(store, { paused: options.paused ?? false })
  // Made a day ago, so events from the last hours came after it.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 24 * 60 * 60_000)
  const automation = seedBotAutomation(store, bot, {}, { ...EVENT_ONLY_SCHEDULE, on: [MENTIONED] })
  clock.mockRestore()
  const sessions = fakeSessions()
  const { results, endTurn } = fakeResults()
  const service = new AutomationService(store, {
    tickMs: 60_000,
    botDispatcher: createBotAutomationDispatcher(sessions, results)
  })
  return { bot, automation, sessions, endTurn, service }
}

describe('automations started by events', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-event-automation-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('starts one run per event, quoting the event after the prompt', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)
    const eventText = '@Alice can you look at why deploys are failing?'
    const event = slackEvent({ text: eventText })

    const run = await service.runForEvent(automation.id, event)
    expect(await service.runForEvent(automation.id, event)).toMatchObject({ id: run?.id })

    expect(run).toMatchObject({ status: 'dispatched', trigger: 'event', event })
    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(sessions.startConversation).toHaveBeenCalledOnce()
    const { text, run: fields } = sessions.startConversation.mock.calls[0]![1]
    expect(fields?.memorySource).toBe('Slack #infra, Dana Lee')
    const [prompt, quoted] = text.split('\n<<<\n')
    expect(prompt).toMatch(/^Summarize what changed overnight\n/)
    expect(prompt).not.toContain(eventText)
    expect(quoted).toContain(`${eventText}\n>>>`)
  })

  it("records an event its bot's turn ran as handled there, so the event starts nothing more", async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)
    const event = slackEvent()
    const chat = { worktreeId: 'bot-home', sessionId: 'chat-1' }

    const run = await service.runForEvent(automation.id, event, { inTurn: chat })
    expect(run).toMatchObject({
      status: 'completed',
      trigger: 'event',
      event,
      handledInTurn: true,
      sessionKind: 'chat',
      chatSessionId: 'chat-1',
      workspaceId: 'bot-home'
    })
    // Recorded once; the event arriving on its own (a resend) starts no run.
    expect(await service.runForEvent(automation.id, event, { inTurn: chat })).toBeNull()
    expect(await service.runForEvent(automation.id, event)).toMatchObject({ id: run?.id })
    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('folds repeats on a thread into its unfinished run, and starts afresh once it ends', async () => {
    const store = await createStore()
    const { automation, sessions, endTurn, service } = setup(store)
    const first = await service.runForEvent(automation.id, slackEvent())

    vi.advanceTimersByTime(1000)
    const folded = await service.runForEvent(
      automation.id,
      slackEvent({ key: 'T1:C1:1700.02', occurredAt: Date.now() })
    )
    expect(folded).toMatchObject({ id: first?.id, occurrenceCount: 2 })
    expect(sessions.startConversation).toHaveBeenCalledOnce()

    endTurn({ outcome: 'success', message: 'Replied.' })
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    vi.advanceTimersByTime(1000)
    const next = await service.runForEvent(
      automation.id,
      slackEvent({ key: 'T1:C1:1700.03', occurredAt: Date.now() })
    )
    expect(next?.id).not.toBe(first?.id)
    expect(sessions.startConversation).toHaveBeenCalledTimes(2)
  })

  it('folds simultaneous events, and events at the same moment, into one run', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)
    const second = slackEvent({ key: 'T1:C1:1700.02' })

    const [first, folded] = await Promise.all([
      service.runForEvent(automation.id, slackEvent()),
      service.runForEvent(automation.id, second)
    ])

    expect(folded).toMatchObject({ id: first?.id, occurrenceCount: 2, event: second })
    // A resend of either event, the replaced one too, is the same run.
    expect(await service.runForEvent(automation.id, second)).toMatchObject({ occurrenceCount: 2 })
    expect(await service.runForEvent(automation.id, slackEvent())).toMatchObject({
      id: first?.id,
      occurrenceCount: 2
    })
    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(sessions.startConversation).toHaveBeenCalledOnce()
    // Run now replays the latest event, not the one that started the run.
    expect((await runNowSettled(service, store, automation.id)).event).toEqual(second)
  })

  it('keeps the latest event when an older one arrives late, and still counts it', async () => {
    const store = await createStore()
    const { automation, service } = setup(store)
    const latest = slackEvent({ key: 'T1:C1:1700.02' })

    await service.runForEvent(automation.id, latest)
    const folded = await service.runForEvent(
      automation.id,
      slackEvent({ occurredAt: latest.occurredAt - 1000 })
    )

    expect(folded).toMatchObject({ occurrenceCount: 2, event: latest })
    expect(folded?.eventKeys).toEqual(['T1:C1:1700.01'])
  })

  it('starts nothing for an event from before the automation was made', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)
    await expect(
      service.runForEvent(automation.id, slackEvent({ occurredAt: automation.createdAt - 1 }))
    ).resolves.toBeNull()
    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('records events past the Grace window as one missed row', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)
    const late = Date.now() - (automation.missedRunGraceMinutes + 10) * 60_000

    await service.runForEvent(
      automation.id,
      slackEvent({ key: 'a', subject: 'a', occurredAt: late })
    )
    const missed = await service.runForEvent(
      automation.id,
      slackEvent({ key: 'b', subject: 'b', occurredAt: late + 1 })
    )

    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(missed).toMatchObject({
      status: 'skipped_missed',
      trigger: 'event',
      error: MISSED_RUN,
      occurrenceCount: 2
    })
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('folds events for a paused bot into one skipped row', async () => {
    const store = await createStore()
    const { automation, service } = setup(store, { paused: true })

    await service.runForEvent(automation.id, slackEvent({ key: 'a', subject: 'a' }))
    vi.advanceTimersByTime(1000)
    await service.runForEvent(
      automation.id,
      slackEvent({ key: 'b', subject: 'b', occurredAt: Date.now() })
    )

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      trigger: 'event',
      error: 'Reviewer is paused, so Orca skipped this run.',
      occurrenceCount: 2
    })
  })

  it('takes no event once the automation is paused or the trigger is gone', async () => {
    const store = await createStore()
    const { automation, service } = setup(store)

    expect(await service.runForEvent(automation.id, slackEvent({ triggerId: 'gone' }))).toBeNull()
    store.updateAutomation(automation.id, { enabled: false })
    expect(await service.runForEvent(automation.id, slackEvent())).toBeNull()
    expect(store.listAutomationRuns(automation.id)).toEqual([])
  })

  it('replays the latest event on Run now, labelled manual', async () => {
    const store = await createStore()
    const { automation, sessions, endTurn, service } = setup(store)

    const blank = await runNowSettled(service, store, automation.id)
    expect(blank).toMatchObject({ trigger: 'manual' })
    expect(blank.event).toBeUndefined()
    expect(sessions.startConversation.mock.calls[0]![1].text).toBe(automation.prompt)
    endTurn({ outcome: 'success', message: 'Done.' })
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )

    const event = slackEvent()
    await service.runForEvent(automation.id, event)
    endTurn({ outcome: 'success', message: 'Done.' })
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    vi.advanceTimersByTime(1000)
    const replay = await runNowSettled(service, store, automation.id)

    expect(replay).toMatchObject({ trigger: 'manual', event })
    expect(sessions.startConversation.mock.calls[2]![1].text).toContain(event.text)
  })

  it('never runs an event-only automation on its stored schedule, even on an older Orca', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store)

    // The scheduler an older Orca has: it reads only nextRunAt, rrule and dtstart.
    expect(automation.nextRunAt).toBeGreaterThanOrEqual(EVENT_ONLY_SCHEDULE.dtstart)
    expect(
      store.getLatestAutomationOccurrence(automation, Date.now() + 10 * 365 * 86_400_000)
    ).toBe(null)
    service.start()
    await vi.advanceTimersByTimeAsync(2 * 86_400_000)

    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })
})

describe('event trigger validation', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-event-automation-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('refuses events on a project automation', async () => {
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
    expect(() =>
      store.createAutomation({
        name: 'Project',
        prompt: 'Go',
        agentId: 'claude',
        projectId: 'r1',
        workspaceMode: 'new_per_run',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 0,
        on: [MENTIONED]
      })
    ).toThrow('Only bot automations can start on events.')
  })

  it('needs a schedule or an event, and refuses unknown or duplicate triggers', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    expect(() => seedBotAutomation(store, bot, {}, { ...EVENT_ONLY_SCHEDULE })).toThrow(
      'An automation needs a schedule or an event to start it.'
    )
    expect(() =>
      seedBotAutomation(store, bot, {}, { on: [MENTIONED, { ...MENTIONED, event: 'message' }] })
    ).toThrow('Each event trigger needs its own id.')
    // A newer Orca's event, as stored data would carry it.
    const unknown = Object.assign({}, MENTIONED, { event: 'pushed' })
    expect(() => seedBotAutomation(store, bot, {}, { on: [unknown] })).toThrow(
      'Unknown event: slack.pushed'
    )

    const automation = seedBotAutomation(
      store,
      bot,
      {},
      { ...EVENT_ONLY_SCHEDULE, on: [MENTIONED] }
    )
    expect(() => store.updateAutomation(automation.id, { on: [] })).toThrow(
      'An automation needs a schedule or an event to start it.'
    )
    const scheduled = store.updateAutomation(automation.id, {
      on: [],
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: 0
    })
    expect(scheduled.on).toBeUndefined()
  })

  describe('results to the event’s thread', () => {
    function threadSetup(store: Store, on: AutomationEventTrigger[] = [MENTIONED]) {
      const bot = seedBot(store)
      const automation = seedBotAutomation(
        store,
        bot,
        { resultsTo: 'thread' },
        { ...EVENT_ONLY_SCHEDULE, on }
      )
      const sessions = fakeSessions()
      const { results, endTurn } = fakeResults()
      const adopt = vi.fn<BotRunThreads['adopt']>(() => true)
      const service = new AutomationService(store, {
        tickMs: 60_000,
        botDispatcher: createBotAutomationDispatcher(sessions, results, { adopt })
      })
      return { bot, automation, results, endTurn, adopt, service }
    }
    const conversation = { source: 'slack' as const, externalId: 'trigger:abc' }

    it("links a slack.mentioned run's chat to the mention's conversation, which posts its result", async () => {
      const store = await createStore()
      const { bot, automation, results, endTurn, adopt, service } = threadSetup(store)

      await service.runForEvent(automation.id, slackEvent({ conversation }))

      expect(adopt).toHaveBeenCalledWith(
        conversation,
        {
          worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
          sessionId: 'new-session',
          agent: bot.agent,
          bot: { kind: 'bot', botId: bot.id }
        },
        expect.any(String)
      )
      endTurn({ outcome: 'success', message: 'On it.' })
      await vi.waitFor(() => expect(results.deliver).toHaveBeenCalled())
      expect(results.deliver.mock.calls[0]![0].target.resultsTo).toBe('thread')
    })

    it('keeps the result in its own conversation when the link fails', async () => {
      const store = await createStore()
      const { automation, results, endTurn, adopt, service } = threadSetup(store)
      adopt.mockReturnValue(false)

      await service.runForEvent(automation.id, slackEvent({ conversation }))
      endTurn({ outcome: 'success', message: 'On it.' })

      await vi.waitFor(() => expect(results.deliver).toHaveBeenCalled())
      expect(results.deliver.mock.calls[0]![0].target.resultsTo).toBe('none')
    })

    it('comments on the Linear issue the event happened on', async () => {
      const store = await createStore()
      const assigned: AutomationEventTrigger = { id: 't2', source: 'linear', event: 'assigned' }
      const { automation, results, endTurn, adopt, service } = threadSetup(store, [assigned])

      await service.runForEvent(automation.id, {
        triggerId: 't2',
        source: 'linear',
        event: 'assigned',
        key: 'linear-1',
        subject: 'ENG-123',
        occurredAt: Date.now()
      })
      endTurn({ outcome: 'success', message: 'Done.' })

      await vi.waitFor(() => expect(results.deliver).toHaveBeenCalled())
      expect(results.deliver.mock.calls[0]![0].target.resultsTo).toEqual({ linearIssue: 'ENG-123' })
      expect(adopt).not.toHaveBeenCalled()
    })

    it('refuses a scheduled automation that sends results to the thread', async () => {
      const store = await createStore()
      const bot = seedBot(store)
      expect(() =>
        seedBotAutomation(store, bot, { resultsTo: 'thread' }, { on: [MENTIONED] })
      ).toThrow('only when events alone start it')
      expect(() =>
        seedBotAutomation(
          store,
          bot,
          { resultsTo: 'thread', runsIn: 'chat' },
          { ...EVENT_ONLY_SCHEDULE, on: [MENTIONED] }
        )
      ).toThrow('--runs-in new')
    })
  })
})
