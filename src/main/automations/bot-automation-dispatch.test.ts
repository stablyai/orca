import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNowSettled } from './testing/automation-run-now-settled.test-fixture'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { Store } from '../persistence/loading-store/store'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { AutomationService } from './automation-service'
import { tickAt } from './testing/automation-service-tick.test-fixture'
import type * as PrecheckRunner from './dispatch/precheck-runner'
import { BOT_MISSING, BOTS_OFF, resolveBotAutomationRunTarget } from './bot-run-target'
import type { AutomationBotLauncher } from './launch/automation-launch'
import { createBotAutomationDispatcher, type BotRunThreads } from './bot-automation-launch'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import {
  fakeResults,
  fakeSessions,
  seedBot,
  seedBotAutomation
} from './bot-automation.test-fixture'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())

vi.mock('./dispatch/precheck-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof PrecheckRunner>()),
  runAutomationPrecheck: runAutomationPrecheckMock
}))

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

function serviceWith(store: Store, botDispatcher: AutomationBotLauncher) {
  const service = new AutomationService(store, { tickMs: 60_000, botDispatcher })
  service.start()
  return { service }
}

describe('bot automations', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bot-automation-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('opens a new conversation in the bot for a scheduled run, not in the window', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot)
    const sessions = fakeSessions()
    serviceWith(store, createBotAutomationDispatcher(sessions, fakeResults().results))

    await tickAt('2026-05-13T09:01:00')

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
    )
    const [run] = store.listAutomationRuns(automation.id)
    expect(sessions.startConversation).toHaveBeenCalledExactlyOnceWith(bot, {
      text: 'Summarize what changed overnight',
      title: run!.title,
      run: {
        memorySource: expect.stringMatching(/^Automation /),
        automationRun: {
          runId: run!.id,
          automation: expect.objectContaining({ id: automation.id, name: 'Morning digest' }),
          trigger: 'scheduled',
          scheduledFor: new Date('2026-05-13T09:00:00').getTime(),
          instructionsLength: 'Summarize what changed overnight'.length
        }
      },
      actsFor: { actsFor: [{ kind: 'owner' }] }
    })
    expect(sessions.sendToChat).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      sessionKind: 'chat',
      chatSessionId: 'new-session',
      terminalSessionId: null,
      workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
      workspaceDisplayName: 'Reviewer'
    })
  })

  it.each([
    { chat: { sessionId: 'side-chat', homeIfGone: true as const }, homeIfGone: true },
    { chat: { sessionId: 'side-chat' }, homeIfGone: undefined }
  ])(
    'runs in its chat, falling back to the Home Chat only when Orca chose it ($homeIfGone)',
    async ({ chat, homeIfGone }) => {
      const store = await createStore()
      const bot = seedBot(store)
      const automation = seedBotAutomation(store, bot, { runsIn: 'chat', chat })
      const sessions = fakeSessions()
      serviceWith(store, createBotAutomationDispatcher(sessions, fakeResults().results))

      await tickAt('2026-05-13T09:01:00')

      await vi.waitFor(() =>
        expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
      )
      expect(sessions.sendToBotChat).toHaveBeenCalledExactlyOnceWith(
        bot,
        'side-chat',
        'Summarize what changed overnight',
        expect.anything(),
        homeIfGone
      )
    }
  )

  it('starts a run on its own agent and model, as the same bot', async () => {
    const store = await createStore()
    const bot = seedBot(store, { launch: { model: 'gpt-6.1-terra' } })
    const agentSetup = { agent: 'claude' as const, launch: { model: 'opus' } }
    const automation = seedBotAutomation(store, bot, { agentSetup }, { agentId: 'claude' })
    const sessions = fakeSessions()
    serviceWith(store, createBotAutomationDispatcher(sessions, fakeResults().results))

    await tickAt('2026-05-13T09:01:00')

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
    )
    expect(sessions.startConversation).toHaveBeenCalledExactlyOnceWith(
      { ...bot, agent: 'claude', launch: { model: 'opus' } },
      expect.anything()
    )
  })

  it("sends the prompt into the bot's Chat when the automation runs there", async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot, { runsIn: 'chat' })
    const sessions = fakeSessions()
    const { service } = serviceWith(
      store,
      createBotAutomationDispatcher(sessions, fakeResults().results)
    )

    const run = await runNowSettled(service, store, automation.id)

    expect(run).toMatchObject({ status: 'dispatched', chatSessionId: 'chat-session' })
    expect(sessions.sendToChat).toHaveBeenCalledExactlyOnceWith(
      bot,
      'Summarize what changed overnight',
      {
        memorySource: expect.stringMatching(/^Automation /),
        automationRun: expect.objectContaining({ runId: run.id, trigger: 'manual' })
      }
    )
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it.each([
    { runsIn: 'new' as const, released: ['new-session'] },
    { runsIn: 'chat' as const, released: [] }
  ])('releases only a conversation the run started, once it ends ($runsIn)', async (each) => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot, { runsIn: each.runsIn })
    const sessions = fakeSessions()
    const { results, endTurn } = fakeResults()
    const { service } = serviceWith(store, createBotAutomationDispatcher(sessions, results))

    await runNowSettled(service, store, automation.id)
    expect(sessions.release).not.toHaveBeenCalled()
    endTurn({ outcome: 'success', message: 'Done.' })

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    expect(sessions.release.mock.calls.map(([sessionId]) => sessionId)).toEqual(each.released)
  })

  it('completes the run when its turn ends, delivering the result to where the automation says', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot, { resultsTo: { channel: 'C123' } })
    const { results, endTurn } = fakeResults()
    const { service } = serviceWith(store, createBotAutomationDispatcher(fakeSessions(), results))

    const run = await runNowSettled(service, store, automation.id)
    expect(results.watch).toHaveBeenCalledOnce()
    endTurn({ outcome: 'success', message: 'All quiet overnight.' })

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('completed')
    )
    expect(results.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        bot,
        sessionId: 'new-session',
        target: { runsIn: 'new', resultsTo: { channel: 'C123' }, letBotReact: false },
        run: expect.objectContaining({ id: run.id })
      })
    )
    expect(store.listAutomationRuns(automation.id)[0]?.outputSnapshot?.content).toBe(
      'All quiet overnight.'
    )
  })

  it('stops watching when the prompt never reaches the bot', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot)
    const sessions = fakeSessions()
    sessions.startConversation.mockRejectedValueOnce(new Error('refused'))
    const { results, dispose } = fakeResults()
    const { service } = serviceWith(store, createBotAutomationDispatcher(sessions, results))

    expect(await runNowSettled(service, store, automation.id)).toMatchObject({
      status: 'dispatch_failed'
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(results.deliver).not.toHaveBeenCalled()
  })

  it('skips runs while the bot is paused, folding repeats into one row', async () => {
    const store = await createStore()
    const bot = seedBot(store, { paused: true })
    const automation = seedBotAutomation(store, bot)
    const botDispatcher = vi.fn<AutomationBotLauncher>()
    serviceWith(store, botDispatcher)
    const nextRunAt = () => store.listAutomations().find((a) => a.id === automation.id)!.nextRunAt

    for (const when of ['2026-05-13T09:01:00', '2026-05-14T09:01:00']) {
      const before = nextRunAt()
      await tickAt(when)
      await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before))
    }

    expect(botDispatcher).not.toHaveBeenCalled()
    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: 'Reviewer is paused, so Orca skipped this run.',
      occurrenceCount: 2
    })
  })

  it('skips, not fails, a run whose bot is paused while its precheck runs', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = store.updateAutomation(seedBotAutomation(store, bot).id, {
      precheck: { command: 'true', timeoutSeconds: 10 }
    })
    runAutomationPrecheckMock.mockImplementationOnce(async () => {
      store.saveBot({ ...bot, paused: true })
      return {
        command: 'true',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt: 1,
        completedAt: 2
      }
    })
    const sessions = fakeSessions()
    serviceWith(store, createBotAutomationDispatcher(sessions, fakeResults().results))

    await tickAt('2026-05-13T09:01:00')

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        status: 'skipped_unavailable',
        error: 'Reviewer is paused, so Orca skipped this run.'
      })
    )
    expect(sessions.startConversation).not.toHaveBeenCalled()
  })

  it('refuses a manual run once the bot is gone', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot)
    store.removeBot(bot)
    const botDispatcher = vi.fn<AutomationBotLauncher>()
    const { service } = serviceWith(store, botDispatcher)

    const run = await runNowSettled(service, store, automation.id)

    expect(run).toMatchObject({ status: 'skipped_unavailable', error: BOT_MISSING })
    expect(botDispatcher).not.toHaveBeenCalled()
  })

  it('skips a bot run while bots are turned off, keeping the bot', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot)
    store.updateSettings({ botsEnabled: false })
    const botDispatcher = vi.fn<AutomationBotLauncher>()
    const { service } = serviceWith(store, botDispatcher)

    const run = await runNowSettled(service, store, automation.id)

    expect(run).toMatchObject({ status: 'skipped_unavailable', error: BOTS_OFF })
    expect(botDispatcher).not.toHaveBeenCalled()
    expect(store.getBots()).toEqual([bot])
  })

  it('leaves a dispatched bot run alone when Orca restarts, as no terminal holds it', async () => {
    const store = await createStore()
    const bot = seedBot(store)
    const automation = seedBotAutomation(store, bot)
    store.updateAutomation(automation.id, { enabled: false })
    const run = store.createAutomationRun(automation, 1_000, 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
      chatSessionId: 'session-1'
    })
    const service = new AutomationService(store, {
      terminalObserver: {
        resolveRunTerminal: () => null,
        observeCompletion: vi.fn()
      }
    })

    service.start()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'dispatched',
      chatSessionId: 'session-1'
    })
    service.stop()
  })

  describe('results to the event thread', () => {
    const event = {
      triggerId: 't1',
      source: 'slack' as const,
      event: 'mentioned' as const,
      key: 'T1:C1:1.1',
      occurredAt: 1,
      conversation: { source: 'slack' as const, externalId: 'trigger:abc' }
    }
    const runOf = (trigger: AutomationRun['trigger']): AutomationRun => ({
      id: 'run-1',
      automationId: 'a1',
      title: 'Morning digest',
      scheduledFor: 1,
      status: 'pending',
      trigger,
      workspaceId: null,
      sessionKind: 'chat',
      chatSessionId: null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null,
      outputSnapshot: null,
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: null,
      dispatchedAt: null,
      createdAt: 1,
      event
    })

    const OWNER_THREAD = { source: 'slack' as const, externalId: 'T1:C1:1.1:U0BOT' }
    const ownerChat = { worktreeId: 'bots', sessionId: 'owner-chat', agent: 'claude' as const }

    async function dispatch(
      trigger: AutomationRun['trigger'],
      {
        runsIn = 'new',
        owner
      }: {
        runsIn?: 'new' | 'chat'
        owner?: Awaited<ReturnType<NonNullable<BotRunThreads['ownerChat']>>>
      } = {}
    ) {
      const store = await createStore()
      const bot = seedBot(store)
      // The store admits thread results only for event-only automations; the dispatcher reads the target.
      const automation = {
        ...seedBotAutomation(store, bot),
        bot: { botId: bot.id, runsIn, resultsTo: 'thread' as const }
      }
      const { results, endTurn } = fakeResults()
      const sessions = fakeSessions()
      const threads = {
        adopt: vi.fn<BotRunThreads['adopt']>(() => true),
        ownerChat: vi.fn<NonNullable<BotRunThreads['ownerChat']>>(async () => owner ?? null),
        release: vi.fn<NonNullable<BotRunThreads['release']>>()
      }
      const run = runOf(trigger)
      if (owner !== undefined && run.event) {
        run.event = { ...run.event, threadOwner: { conversation: OWNER_THREAD, actsFor: 'owner' } }
      }
      const launch = await createBotAutomationDispatcher(
        sessions,
        results,
        threads
      )({
        automation,
        run,
        target: {
          ok: true,
          cwd: '/bots/reviewer',
          bot,
          workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
          runsIn
        }
      })
      endTurn({ outcome: 'success', message: 'Done.' })
      await launch.completion
      return { threads, sessions, target: results.deliver.mock.calls[0]?.[0].target }
    }

    it('runs in the chat that owns the thread, posting its result there, whoever that chat acts for', async () => {
      const { threads, sessions, target } = await dispatch('event', {
        owner: ownerChat
      })
      expect(sessions.sendToSession.mock.calls[0]?.[1]).toBe('owner-chat')
      expect(sessions.startConversation).not.toHaveBeenCalled()
      // Queued behind whatever turn runs there, so no turn is marked as the thread's.
      expect(threads.adopt).not.toHaveBeenCalled()
      expect(target).toMatchObject({ resultsTo: 'thread', threadPost: OWNER_THREAD })
    })

    it("never takes the thread from the bot's Chat, posting its result there instead", async () => {
      const { threads, sessions, target } = await dispatch('event', { runsIn: 'chat' })
      expect(sessions.sendToChat).toHaveBeenCalledOnce()
      expect(threads.adopt).not.toHaveBeenCalled()
      expect(target).toMatchObject({ resultsTo: 'thread', threadPost: event.conversation })
    })

    it('frees a thread whose chat was deleted and takes it', async () => {
      const { threads, target } = await dispatch('event', { owner: 'gone' })
      expect(threads.release).toHaveBeenCalledWith(OWNER_THREAD)
      expect(threads.adopt.mock.calls[0]?.[0]).toEqual(event.conversation)
      expect(target).toEqual({ runsIn: 'new', resultsTo: 'thread', letBotReact: false })
    })

    it("links the thread to the agent its own setup runs on, not the bot's", async () => {
      const store = await createStore()
      const bot = seedBot(store)
      const agentSetup = { agent: 'claude' as const }
      const automation = {
        ...seedBotAutomation(store, bot, { agentSetup }, { agentId: 'claude' }),
        bot: { botId: bot.id, runsIn: 'new' as const, resultsTo: 'thread' as const, agentSetup }
      }
      const target = resolveBotAutomationRunTarget(store, automation.bot)
      if (!target.ok) {
        throw new Error(target.error)
      }
      const { results, endTurn } = fakeResults()
      const threads = { adopt: vi.fn<BotRunThreads['adopt']>(() => true) }
      const launch = await createBotAutomationDispatcher(
        fakeSessions(),
        results,
        threads
      )({ automation, run: runOf('event'), target })
      endTurn({ outcome: 'success', message: 'Done.' })
      await launch.completion

      expect(bot.agent).toBe('codex')
      expect(threads.adopt.mock.calls[0]?.[1]).toMatchObject({ agent: 'claude' })
    })

    it("acts for the bot's owner, whoever made the automation and whatever started the run", async () => {
      const store = await createStore()
      const bot = seedBot(store)
      const teammate = {
        kind: 'person' as const,
        source: 'slack' as const,
        userId: 'U0MEMBER',
        workspaceId: 'T1',
        role: 'member' as const
      }
      const ownersAutomation = seedBotAutomation(store, bot)
      // Saved by an older host for a teammate's request; no longer read.
      const teammatesAutomation = { ...seedBotAutomation(store, bot), actsFor: [teammate] }
      const sessions = fakeSessions()
      const { results, endTurn } = fakeResults()
      const target = {
        ok: true as const,
        cwd: '/bots/reviewer',
        bot,
        workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
        runsIn: 'new' as const
      }
      const launch = createBotAutomationDispatcher(sessions, results)
      const scheduled = runOf('scheduled')
      delete scheduled.event
      for (const automation of [ownersAutomation, teammatesAutomation]) {
        for (const run of [runOf('event'), scheduled]) {
          const launched = await launch({ automation, run, target })
          endTurn({ outcome: 'success', message: 'Done.' })
          await launched.completion
        }
      }
      const actsFor = sessions.startConversation.mock.calls.map(
        ([, start]) => start.actsFor?.actsFor
      )
      expect(actsFor).toEqual(Array.from({ length: 4 }, () => [{ kind: 'owner' }]))

      // Set to run in the bot's Chat, it runs there, as the owner's own would.
      const inChat = {
        ...teammatesAutomation,
        bot: { ...teammatesAutomation.bot!, runsIn: 'chat' as const }
      }
      const launched = await launch({
        automation: inChat,
        run: scheduled,
        target: { ...target, runsIn: 'chat' }
      })
      endTurn({ outcome: 'success', message: 'Done.' })
      await launched.completion
      expect(sessions.sendToChat).toHaveBeenCalledOnce()
      expect(sessions.startConversation).toHaveBeenCalledTimes(4)
    })

    it("links an event run to its event's thread", async () => {
      const { threads, target } = await dispatch('event')
      expect(threads.adopt).toHaveBeenCalledOnce()
      expect(target).toEqual({ runsIn: 'new', resultsTo: 'thread', letBotReact: false })
    })

    it("keeps Run now's result in its own conversation, though it replays the last event", async () => {
      const { threads, target } = await dispatch('manual')
      expect(threads.adopt).not.toHaveBeenCalled()
      expect(target).toEqual({ runsIn: 'new', resultsTo: 'none', letBotReact: false })
    })
  })
})
