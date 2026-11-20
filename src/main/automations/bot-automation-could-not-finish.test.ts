import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNowSettled } from './testing/automation-run-now-settled.test-fixture'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import type { Bot } from '../../shared/bot-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import type { Store } from '../persistence/loading-store/store'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import type { OwnerNotice } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import {
  alertBotCouldNotStart,
  botRunRefusalAlerts,
  type BotOwnerNoticeDeps
} from '../bots/bot-could-not-finish'
import { AutomationService } from './automation-service'
import { tickAt } from './testing/automation-service-tick.test-fixture'
import { createBotAutomationDispatcher } from './bot-automation-launch'
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

function alerts() {
  const notices: OwnerNotice[] = []
  const deps: BotOwnerNoticeDeps = { notify: (notice) => notices.push(notice) }
  return { deps, notices }
}

function serviceWith(store: Store, sessions = fakeSessions()) {
  const told = alerts()
  const { results, endTurn } = fakeResults()
  results.couldNotStart.mockImplementation((bot, automation) =>
    alertBotCouldNotStart(told.deps, bot, automation)
  )
  const service = new AutomationService(store, {
    tickMs: 60_000,
    botDispatcher: createBotAutomationDispatcher(sessions, results),
    onRunRefused: botRunRefusalAlerts(told.deps, () => store.getBots?.() ?? [])
  })
  service.start()
  return { service, told, results, endTurn }
}

// A bot whose folder workspace is gone, as after the owner deletes it.
function seedFolderlessBot(store: Store, overrides: Partial<Bot> = {}): Bot {
  const bot = { ...seedBot(store), folderWorkspaceId: 'gone', ...overrides }
  store.saveBot(bot)
  return bot
}

describe("a bot run refused before its turn tells the owner it couldn't finish", () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bot-could-not-finish-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('tells once, on the desktop and the phone, when the folder is gone, however often it repeats', async () => {
    const store = await createStore()
    const bot = seedFolderlessBot(store, { chatSessionId: 'home-chat' })
    const automation = seedBotAutomation(store, bot)
    const { told } = serviceWith(store)
    const nextRunAt = () => store.listAutomations().find((a) => a.id === automation.id)!.nextRunAt

    for (const when of ['2026-05-13T09:01:00', '2026-05-14T09:01:00']) {
      const before = nextRunAt()
      await tickAt(when)
      await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before))
    }

    const notice = {
      title: "Reviewer couldn't finish",
      body: `"Morning digest" couldn't start because the bot's folder is missing.`
    }
    expect(told.notices).toEqual([
      {
        id: 'bot-could-not-finish:bot-1:Morning digest',
        ...notice,
        worktreeId: 'folder:gone',
        paneKey: structuredAgentSessionPaneKey(
          structuredAgentSessionTabId('home-chat'),
          'home-chat'
        )
      }
    ])
  })

  it('stays quiet for a paused bot, or one whose switch is off', async () => {
    const store = await createStore()
    const paused = seedFolderlessBot(store, { paused: true })
    const { service, told } = serviceWith(store)
    await runNowSettled(service, store, seedBotAutomation(store, paused).id)
    const quiet = seedFolderlessBot(store, {
      id: 'bot-quiet',
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: false }
    })
    await runNowSettled(service, store, seedBotAutomation(store, quiet).id)

    expect(told.notices).toEqual([])
  })

  it('tells once after a bot whose folder went while paused is unpaused', async () => {
    const store = await createStore()
    const bot = seedFolderlessBot(store, { paused: true })
    const automation = seedBotAutomation(store, bot)
    const { told } = serviceWith(store)
    const nextRunAt = () => store.listAutomations().find((a) => a.id === automation.id)!.nextRunAt
    const runAt = async (when: string) => {
      const before = nextRunAt()
      await tickAt(when)
      await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before))
    }

    await runAt('2026-05-13T09:01:00')
    expect(store.listAutomationRuns(automation.id)[0]?.error).toBe(
      'Reviewer is paused, so Orca skipped this run.'
    )
    expect(told.notices).toEqual([])

    store.saveBot({ ...bot, paused: false })
    await runAt('2026-05-14T09:01:00')
    await runAt('2026-05-15T09:01:00')

    expect(told.notices).toHaveLength(1)
  })

  it("tells once when the bot's session refuses the prompt", async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const sessions = fakeSessions()
    sessions.startConversation.mockRejectedValueOnce(new Error('bot_session_refused: busy'))
    const { service, told, results } = serviceWith(store, sessions)

    const run = await runNowSettled(service, store, seedBotAutomation(store, bot).id)
    expect(run).toMatchObject({ status: 'dispatch_failed' })
    // A new conversation that never opened shows why in the bot's Chat, with what it would have sent.
    expect(results.couldNotStart.mock.calls[0]![2]).toEqual({
      destination: { kind: 'chat' },
      card: {
        kind: 'automation-run-not-started',
        run: expect.objectContaining({ runId: run.id, trigger: 'manual' }),
        actsFor: [{ kind: 'owner' }],
        error: 'bot_session_refused: busy',
        text: 'Summarize what changed overnight',
        at: Date.now()
      }
    })

    // No Home Chat yet, so the tap opens the bot's home.
    expect(told.notices).toEqual([
      {
        id: 'bot-could-not-finish:bot-1:Morning digest',
        title: "Reviewer couldn't finish",
        body: `"Morning digest" couldn't start.`,
        worktreeId: `folder:${bot.folderWorkspaceId}`
      }
    ])
  })

  it('leaves a turn that ended without finishing to its own path, so nothing is told twice', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const { service, told, results, endTurn } = serviceWith(store)

    await runNowSettled(service, store, seedBotAutomation(store, bot).id)
    endTurn({ outcome: 'failure', message: '' })
    await vi.waitFor(() => expect(results.deliver).toHaveBeenCalledOnce())

    expect(results.couldNotStart).not.toHaveBeenCalled()
    expect(told.notices).toEqual([])
  })
})
