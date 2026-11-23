import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { WAIT_EXPIRY_MS } from '../../shared/automation-once'
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
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeBotWaits } from './bot-waits'

const appendOrcaChatCard = vi.hoisted(() => vi.fn())

vi.mock('../runtime/orca-chat-card', () => ({ appendOrcaChatCard }))
vi.mock('./bot-chat-session', () => ({
  runtimeBotChats: () => ({ ensure: async () => 'home-chat' })
}))
vi.mock('../runtime/rpc/methods/bots-chats', () => ({ botChatTakingMail: async () => null }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const PR: AutomationEventTrigger = {
  id: 't1',
  source: 'github',
  event: 'ci_passed',
  subject: 'acme/widgets#851'
}

function setup(store: Store) {
  const bot = seedBot(store, { paused: false })
  const automation = seedBotAutomation(
    store,
    bot,
    { runsIn: 'chat' },
    { ...EVENT_ONLY_SCHEDULE, name: 'PR #851', on: [PR], once: {} }
  )
  const sessions = fakeSessions()
  const { results, endTurn } = fakeResults()
  const service = new AutomationService(store, {
    tickMs: 60_000,
    botDispatcher: createBotAutomationDispatcher(sessions, results)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a wait reads only these.
  const runtime = {
    bots: { list: () => store.getBots?.() ?? [] },
    deleteAutomation: async (id: string) => store.deleteAutomation(id)
  } as unknown as OrcaRuntimeService
  service.once = runtimeBotWaits(runtime)
  service.start()
  return { automation, sessions, endTurn, service }
}

describe("a bot's waits in its chat", () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bot-waits-test-'))
    appendOrcaChatCard.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T14:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('shows a wait that fired once: as its run row, with no Wait over card beside it', async () => {
    const store = await createStore()
    const { automation, sessions, endTurn, service } = setup(store)
    vi.advanceTimersByTime(1000)

    await service.runForEvent(automation.id, {
      triggerId: 't1',
      source: 'github',
      event: 'ci_passed',
      key: 'k1',
      subject: 'acme/widgets#851',
      occurredAt: Date.now(),
      actor: 'Alice-H'
    })
    endTurn({ outcome: 'success', message: 'Merged.' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sessions.sendToChat.mock.calls[0]![2]?.automationRun?.wait).toMatchObject({
      kind: 'event'
    })
    expect(appendOrcaChatCard).not.toHaveBeenCalled()
  })

  it('shows a wait that ended unrun as a card', async () => {
    const store = await createStore()
    const { automation } = setup(store)

    vi.setSystemTime(automation.createdAt + WAIT_EXPIRY_MS)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(appendOrcaChatCard).toHaveBeenCalledExactlyOnceWith(
      'home-chat',
      expect.objectContaining({
        kind: 'wait-ended',
        ending: expect.objectContaining({ kind: 'expired' })
      }),
      'showing how a wait ended'
    )
  })
})
