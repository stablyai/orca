import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { AutomationService } from '../automations/automation-service'
import { createBotAutomationDispatcher } from '../automations/bot-automation-launch'
import {
  fakeResults,
  fakeSessions,
  seedBot,
  seedBotAutomation
} from '../automations/bot-automation.test-fixture'
import { runOwnPrGuarded, type OwnPrGuardDeps } from './own-pr-trigger-guard'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const MY_PRS: AutomationEventTrigger = {
  id: 't1',
  source: 'github',
  event: 'pr_opened',
  in: ['acme/web'],
  fromOwner: true
}
const WINDOW_MS = 15 * 60_000

type Delivery = Parameters<typeof runOwnPrGuarded>[3]

function ownPr(number: number): { run: AutomationRunEvent; event: Delivery['event'] } {
  const pr = { repoId: '777', number, headRef: `carol/pr-${number}`, headSha: 'a'.repeat(40) }
  const event = {
    key: `pr:${number}:opened`,
    subject: `acme/web#${number}`,
    occurredAt: Date.now(),
    actorId: '100',
    fromOwner: true as const,
    place: 'acme/web'
  }
  return {
    run: { ...event, triggerId: 't1', source: 'github', event: 'pr_opened' },
    event: { ...event, pr }
  }
}

function setup(store: Store) {
  const bot = seedBot(store)
  // Made a day ago, so events from the last hours came after it.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 24 * 60 * 60_000)
  const automation = seedBotAutomation(store, bot, {}, { ...EVENT_ONLY_SCHEDULE, on: [MY_PRS] })
  clock.mockRestore()
  const service = new AutomationService(store, {
    tickMs: 60_000,
    botDispatcher: createBotAutomationDispatcher(fakeSessions(), fakeResults().results)
  })
  const deps = (overrides: Partial<OwnPrGuardDeps> = {}): OwnPrGuardDeps => ({
    isBotWork: async () => false,
    runs: (id) => store.listAutomationRuns(id),
    ...overrides
  })
  const fire = (number: number, guard: OwnPrGuardDeps = deps()) => {
    const { run, event } = ownPr(number)
    return runOwnPrGuarded(
      guard,
      (id, runEvent, gate) => service.runForEvent(id, runEvent, gate),
      run,
      { automationId: automation.id, event }
    )
  }
  return { automation, fire, deps }
}

describe('own pull requests reaching an automation', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-own-pr-runs-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('starts at most five runs for six pull requests delivered together', async () => {
    const store = await createStore()
    const { automation, fire } = setup(store)

    const started = await Promise.all([1, 2, 3, 4, 5, 6].map((number) => fire(number)))

    expect(started.filter(Boolean)).toHaveLength(5)
    expect(store.listAutomationRuns(automation.id)).toHaveLength(5)
  })

  it("counts a resent pull request once, and frees the cap once a run's window has passed", async () => {
    const store = await createStore()
    const { automation, fire } = setup(store)
    for (const number of [1, 2, 3, 4]) {
      expect(await fire(number)).toBe(true)
    }
    // The same pull request again reaches its run and uses none of the cap.
    await fire(4)
    expect(await fire(5)).toBe(true)
    expect(await fire(6)).toBe(false)

    vi.setSystemTime(Date.now() + WINDOW_MS - 1)
    expect(await fire(7)).toBe(false)
    vi.setSystemTime(Date.now() + 2)
    expect(await fire(8)).toBe(true)
    expect(store.listAutomationRuns(automation.id)).toHaveLength(6)
  })

  it('starts nothing when from=me came off the rule while the pull request was checked', async () => {
    const store = await createStore()
    const { automation, fire, deps } = setup(store)
    const { fromOwner: _mine, ...anyone } = MY_PRS
    const optOut = deps({
      isBotWork: async () => {
        store.updateAutomation(automation.id, { on: [anyone] })
        return false
      }
    })

    expect(await fire(1, optOut)).toBe(false)
    expect(store.listAutomationRuns(automation.id)).toHaveLength(0)
  })
})
