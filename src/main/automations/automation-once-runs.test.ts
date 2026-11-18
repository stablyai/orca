import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import { WAIT_EXPIRY_MS, type AutomationOnce } from '../../shared/automation-once'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'
import type { AutomationOnceEffects } from './automation-trigger-runs'
import { createBotAutomationDispatcher } from './bot-automation-launch'
import { runOnceDue } from './automation-due-runs'
import { createAutomationRunWriter } from './run-history/run-writer'
import { resolveAutomationRunTarget } from './ownership/run-target-resolution'
import {
  deleteAutomationRecordingCancelledWait,
  type WaitCancelRuntime
} from '../bots/bot-wait-cancel'
import {
  fakeResults,
  fakeSessions,
  seedBot,
  seedBotAutomation
} from './bot-automation.test-fixture'

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

const HOUR = 60 * 60_000
const REPLY: AutomationEventTrigger = {
  id: 't1',
  source: 'slack',
  event: 'message',
  subject: 'T1:C1:1700.01',
  from: ['U_NORA']
}

function reply(overrides: Partial<AutomationRunEvent> = {}): AutomationRunEvent {
  return {
    triggerId: 't1',
    source: 'slack',
    event: 'message',
    key: 'T1:C1:1700.05',
    subject: 'T1:C1:1700.01',
    occurredAt: Date.now(),
    actor: 'Nora',
    place: '#orca',
    text: "I'll set the signing secrets.",
    ...overrides
  }
}

function setup(
  store: Store,
  wait: AutomationOnce,
  on: AutomationEventTrigger[] = [REPLY],
  graceMinutes?: number
) {
  const bot = seedBot(store, { paused: false })
  const automation = seedBotAutomation(
    store,
    bot,
    { runsIn: 'chat' },
    {
      ...EVENT_ONLY_SCHEDULE,
      name: "Nora's reply in #orca",
      on,
      once: wait,
      ...(graceMinutes === undefined ? {} : { missedRunGraceMinutes: graceMinutes })
    }
  )
  const sessions = fakeSessions()
  const { results, endTurn } = fakeResults()
  const service = new AutomationService(store, {
    tickMs: 60_000,
    botDispatcher: createBotAutomationDispatcher(sessions, results)
  })
  const once = {
    expire: vi.fn<AutomationOnceEffects['expire']>(async (expired) => {
      store.deleteAutomation(expired.id)
    }),
    remove: vi.fn<AutomationOnceEffects['remove']>(async (id) => store.deleteAutomation(id))
  }
  service.once = once
  service.start()
  return { automation, sessions, endTurn, service, once }
}

const listed = (store: Store, id: string) => store.listAutomations().find((a) => a.id === id)

describe('waits: automations that run once', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-once-automation-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('runs once on its event, takes no other, and is deleted after the run', async () => {
    const store = await createStore()
    const { automation, sessions, endTurn, service, once } = setup(store, {
      by: Date.now() + 4 * HOUR
    })
    vi.advanceTimersByTime(1000)

    const run = await service.runForEvent(automation.id, reply())
    expect(run).toMatchObject({ status: 'dispatched', trigger: 'event' })
    // Another reply, even on another thread, starts nothing.
    expect(
      await service.runForEvent(automation.id, reply({ key: 'K2', subject: 'T1:C1:1800.01' }))
    ).toBeNull()

    endTurn({ outcome: 'success', message: 'Nora replied.' })
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listed(store, automation.id)).toBeUndefined()
    expect(once.remove).toHaveBeenCalledOnce()
    // Its deadline, long past, starts nothing.
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
  })

  it('runs once at its deadline when no event came, saying the deadline came first', async () => {
    const store = await createStore()
    const by = Date.now() + 2 * HOUR
    const { automation, sessions, service } = setup(store, { by })

    await vi.advanceTimersByTimeAsync(HOUR)
    expect(sessions.sendToChat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOUR + 60_000)

    expect(sessions.sendToChat).toHaveBeenCalledOnce()
    expect(sessions.sendToChat.mock.calls[0]![1]).toContain(
      `the deadline ${new Date(by).toISOString()} came before the event`
    )
    expect(store.listAutomationRuns(automation.id)).toMatchObject([
      { trigger: 'scheduled', scheduledFor: by }
    ])
    expect(await service.runForEvent(automation.id, reply())).toBeNull()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
  })

  it('starts one run when the event and the deadline arrive together', async () => {
    const store = await createStore()
    const by = Date.now() + HOUR
    const { automation, sessions, service } = setup(store, { by })
    vi.setSystemTime(by + 30_000)

    await Promise.all([
      service.runForEvent(automation.id, reply()),
      vi.advanceTimersByTimeAsync(60_000)
    ])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
  })

  it('without a deadline, expires after 30 days with no run', async () => {
    const store = await createStore()
    const { automation, sessions, once } = setup(store, {})

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(once.expire).not.toHaveBeenCalled()
    vi.setSystemTime(automation.createdAt + WAIT_EXPIRY_MS)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(once.expire).toHaveBeenCalledOnce()
    expect(once.expire).toHaveBeenCalledWith(expect.objectContaining({ id: automation.id }))
    expect(listed(store, automation.id)).toBeUndefined()
    expect(sessions.sendToChat).not.toHaveBeenCalled()
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('cancelled, it never runs', async () => {
    const store = await createStore()
    const by = Date.now() + HOUR
    const { automation, sessions, service } = setup(store, { by })

    store.deleteAutomation(automation.id)
    expect(await service.runForEvent(automation.id, reply())).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(sessions.sendToChat).not.toHaveBeenCalled()
  })

  describe('cancelled while its deadline run is being admitted', () => {
    // The deadline run, held at its refusal check until `admit()`, with Cancel from the chat card.
    function race(store: Store, by: number) {
      const { automation, service, once } = setup(store, { by })
      vi.setSystemTime(by + 1000)
      let admit: () => void = () => {}
      const checked = new Promise<null>((resolve) => (admit = () => resolve(null)))
      const inLane: WaitCancelRuntime['inAutomationLane'] = (id, operation) =>
        service.runInAutomationLane(id, operation)
      const dispatch = vi.fn(async (_automation: Automation, run: AutomationRun) => run)
      const due = () =>
        runOnceDue(
          {
            store,
            runs: createAutomationRunWriter(store, null),
            tickMs: 60_000,
            wakeGate: service.wakeGate,
            inLane,
            describeRefusal: () => checked,
            resolveTarget: (current) => resolveAutomationRunTarget(store, current),
            dispatch,
            launch: () => {},
            once
          },
          automation.id,
          Date.now()
        )
      const recordCancel = vi.fn(async () => ({}))
      const cancel = () =>
        deleteAutomationRecordingCancelledWait(
          {
            showAutomation: (id) => {
              const found = listed(store, id)
              if (!found) {
                throw new Error('automation_not_found')
              }
              return found
            },
            listAutomationRuns: (id) => store.listAutomationRuns(id),
            deleteAutomation: async (id) => {
              store.deleteAutomation(id)
              return { removed: true, id }
            },
            bots: { update: recordCancel },
            inAutomationLane: inLane
          },
          automation.id,
          undefined
        )
      return { due, cancel, admit, dispatch, recordCancel }
    }

    it('lets the run admitted first win: it started, so it is not recorded as cancelled', async () => {
      const store = await createStore()
      const { due, cancel, admit, dispatch, recordCancel } = race(store, Date.now() + HOUR)

      const running = due()
      const cancelling = cancel()
      admit()
      await Promise.all([running, cancelling])

      expect(dispatch).toHaveBeenCalledOnce()
      expect(recordCancel).not.toHaveBeenCalled()
    })

    it('never starts a wait whose cancel came first', async () => {
      const store = await createStore()
      const { due, cancel, admit, recordCancel } = race(store, Date.now() + HOUR)

      const cancelling = cancel()
      const running = due()
      admit()
      await Promise.all([running, cancelling])

      expect(recordCancel).toHaveBeenCalledOnce()
      expect(store.listAutomationRuns()).toEqual([])
    })
  })

  it('as a reminder (a deadline and no event), runs once at that time', async () => {
    const store = await createStore()
    const by = Date.now() + HOUR
    const { sessions } = setup(store, { by }, [])

    await vi.advanceTimersByTimeAsync(HOUR + 60_000)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
    expect(sessions.sendToChat.mock.calls[0]![1]).toContain('the time you were asked to act at')
  })
})

// A wait on one GitHub Actions run: heard only live, so its deadline is what wakes it when the event
// is late or lost.
describe('a wait on a GitHub Actions run', () => {
  const RUN: AutomationEventTrigger = {
    id: 't1',
    source: 'github',
    event: 'workflow_finished',
    in: ['github:42:500'],
    run: '9001'
  }
  const finished = (overrides: Partial<AutomationRunEvent> = {}): AutomationRunEvent => ({
    triggerId: 't1',
    source: 'github',
    event: 'workflow_finished',
    key: 'workflow:500:9001:1',
    occurredAt: Date.now(),
    place: 'acme/web',
    url: 'https://github.com/acme/web/actions/runs/9001',
    text: 'Desktop Build · main: success',
    ...overrides
  })

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-once-automation-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('runs once when the run finishes, and its deadline then starts nothing', async () => {
    const store = await createStore()
    const by = Date.now() + 2 * HOUR
    const { automation, sessions, service } = setup(store, { by }, [RUN])
    vi.advanceTimersByTime(60_000)

    expect(await service.runForEvent(automation.id, finished())).toMatchObject({
      trigger: 'event'
    })
    // The next attempt of a re-run is another event, but the wait has had its one run.
    expect(
      await service.runForEvent(automation.id, finished({ key: 'workflow:500:9001:2' }))
    ).toBeNull()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
  })

  it('wakes at its deadline, saying so, when the event never comes or comes past its grace', async () => {
    const store = await createStore()
    const by = Date.now() + 3 * HOUR
    const { automation, sessions, service } = setup(store, { by }, [RUN], 60)
    const finishedAt = Date.now() + 60_000
    vi.setSystemTime(finishedAt + 2 * HOUR)

    // Delivered two hours late: missed, which doesn't spend the wait's one run.
    await service.runForEvent(automation.id, finished({ occurredAt: finishedAt }))
    expect(store.listAutomationRuns(automation.id)).toMatchObject([{ status: 'skipped_missed' }])
    expect(sessions.sendToChat).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(sessions.sendToChat).toHaveBeenCalledOnce()
    expect(sessions.sendToChat.mock.calls[0]![1]).toContain(
      `the deadline ${new Date(by).toISOString()} came before the event`
    )
  })

  it('takes nothing from a run that finished before the wait was made, and records nothing', async () => {
    const store = await createStore()
    const { automation, sessions, service } = setup(store, { by: Date.now() + HOUR }, [RUN])
    vi.advanceTimersByTime(60_000)

    expect(
      await service.runForEvent(automation.id, finished({ occurredAt: automation.createdAt - 1 }))
    ).toBeNull()
    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(sessions.sendToChat).not.toHaveBeenCalled()
  })

  it('cannot be saved without its deadline', async () => {
    const store = await createStore()
    expect(() => setup(store, {}, [RUN])).toThrow(
      'github.workflow_finished is a wait with a deadline'
    )
  })
})

describe('wait validation', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-once-automation-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('refuses a schedule, a deadline before now, and a wait with nothing to start it', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    expect(() => seedBotAutomation(store, bot, {}, { once: {}, on: [REPLY] })).toThrow(
      /not a schedule/
    )
    expect(() =>
      seedBotAutomation(store, bot, {}, { ...EVENT_ONLY_SCHEDULE, once: { by: 1 }, on: [REPLY] })
    ).toThrow(/after it was made/)
    expect(() => seedBotAutomation(store, bot, {}, { ...EVENT_ONLY_SCHEDULE, once: {} })).toThrow(
      /needs an event/
    )
  })
})
