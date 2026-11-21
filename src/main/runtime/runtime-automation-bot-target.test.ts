import './rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { makeTestBot } from '../bots/bot.test-fixture'
import { BotsDisabledError } from '../../shared/bots-switch'
import { RpcDispatcher } from './rpc/dispatcher'
import { AUTOMATION_METHODS } from './rpc/methods/automations/automations'
import type { OrcaRuntimeService } from './orca-runtime'
import { RuntimeAutomationController } from './integrations/automations/runtime-automation-controller'
import {
  EVENT_ONLY_SCHEDULE,
  THREAD_REPLIES_UNSUPPORTED
} from '../../shared/automation-event-triggers'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const botTarget: AutomationBotTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }

const schedule = {
  name: 'Morning digest',
  prompt: 'Summarize the night',
  agentId: 'codex',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1
} as const

async function setup() {
  const store = await createStore()
  store.addRepo({
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#fff',
    addedAt: 1
  })
  const group = store.createProjectGroup({
    name: 'Reviewer',
    createdFrom: 'manual',
    parentPath: '/bots/reviewer'
  })
  const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Reviewer' })
  store.saveBot(
    makeTestBot({ folderWorkspaceId: workspace.id, slack: { appId: 'A1', teamId: 'T1' } })
  )
  const resolvers = {
    showRepo: vi.fn(async () => store.getRepos()[0]!),
    showManagedWorktree: vi.fn(async () => {
      throw new Error('a bot automation must not look up a worktree')
    })
  }
  return {
    store,
    folderKey: `folder:${workspace.id}`,
    resolvers,
    controller: new RuntimeAutomationController(store, resolvers)
  }
}

describe('RuntimeAutomationController bot target', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bot-automation-controller-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it("saves a chat the bot has with its title, and refuses one it doesn't", async () => {
    const { controller } = await setup()
    controller.botChat = async (_bot, id) => (id === 'side-chat' ? { title: 'Deploys' } : null)
    const inChat = { ...botTarget, runsIn: 'chat' as const, chat: { sessionId: 'side-chat' } }

    await expect(controller.create({ ...schedule, bot: inChat })).resolves.toMatchObject({
      bot: { runsIn: 'chat', chat: { sessionId: 'side-chat', title: 'Deploys' } }
    })
    await expect(
      controller.create({ ...schedule, bot: { ...inChat, chat: { sessionId: 'gone' } } })
    ).rejects.toThrow('has no chat chat:gone that takes mail')
    // A chat Orca chose for a wait keeps saying so, so the run falls back to the Home Chat.
    await expect(
      controller.create({
        ...schedule,
        bot: { ...inChat, chat: { sessionId: 'side-chat', homeIfGone: true } }
      })
    ).resolves.toMatchObject({
      bot: { chat: { sessionId: 'side-chat', title: 'Deploys', homeIfGone: true } }
    })
  })

  it('refuses to make or point an automation at a bot while bots are off', async () => {
    const { controller, store } = await setup()
    const existing = await controller.create({ ...schedule, bot: botTarget })
    store.updateSettings({ botsEnabled: false })

    await expect(controller.create({ ...schedule, bot: botTarget })).rejects.toThrow(
      BotsDisabledError
    )
    await expect(
      controller.update(existing.id, { bot: { ...botTarget, runsIn: 'chat' } })
    ).rejects.toThrow(BotsDisabledError)
    // Editing what does not target a bot still works, as listing and reading do.
    await expect(controller.update(existing.id, { name: 'Renamed' })).resolves.toMatchObject({
      name: 'Renamed'
    })
    expect(store.listAutomations()).toHaveLength(1)
  })

  it("saves results to the event's thread only when this host's Orca Cloud binds the thread", async () => {
    const { controller, store } = await setup()
    const onMention = {
      ...schedule,
      ...EVENT_ONLY_SCHEDULE,
      on: [{ id: 't1', source: 'slack' as const, event: 'mentioned' as const }]
    }
    const thread: AutomationBotTarget = { ...botTarget, resultsTo: 'thread' }
    // An older cloud, which doesn't list the feature: nothing is saved that would lose every post.
    await expect(controller.create({ ...onMention, bot: thread })).rejects.toThrow(
      THREAD_REPLIES_UNSUPPORTED
    )
    const saved = await controller.create({ ...onMention, bot: botTarget })
    await expect(controller.update(saved.id, { bot: thread })).rejects.toThrow(
      THREAD_REPLIES_UNSUPPORTED
    )
    expect(store.listAutomations()[0]?.bot?.resultsTo).toBe('chat')

    controller.takesThreadReplies = () => true
    await expect(controller.update(saved.id, { bot: thread })).resolves.toMatchObject({
      bot: { resultsTo: 'thread' }
    })
    // One already saved keeps working when the cloud goes quiet; its other edits still save.
    controller.takesThreadReplies = () => false
    await expect(controller.update(saved.id, { name: 'Renamed' })).resolves.toMatchObject({
      name: 'Renamed'
    })
  })

  it('saves places as refs where the cloud takes them, and only ids and keys where it does not', async () => {
    const { controller, store } = await setup()
    const onMention = (place: string) => ({
      ...schedule,
      ...EVENT_ONLY_SCHEDULE,
      on: [{ id: 't1', source: 'slack' as const, event: 'mentioned' as const, in: [place] }]
    })
    await expect(controller.create({ ...onMention('#eng'), bot: botTarget })).rejects.toThrow(
      'in= takes Slack channel ids'
    )
    const older = await controller.create({ ...onMention('C0ENG'), bot: botTarget })
    controller.placeRefs = () => async (_bot, _source, _role, input) => {
      const id = input === '#eng' ? 'C0ENG' : 'C0RES'
      return { ref: `slack:T1:${id}`, label: input, key: id }
    }
    const saved = await controller.create({
      ...onMention('#eng'),
      bot: { ...botTarget, resultsTo: { channel: '#results' } }
    })
    expect(saved.on).toEqual([
      {
        id: 't1',
        source: 'slack',
        event: 'mentioned',
        in: ['slack:T1:C0ENG'],
        names: { 'slack:T1:C0ENG': '#eng' }
      }
    ])
    const posted = { channel: 'C0RES', ref: 'slack:T1:C0RES', label: '#results' }
    expect(saved.bot?.resultsTo).toEqual(posted)
    // An older client keeps the id it shows and sends back only that; the ref stays.
    await expect(
      controller.update(saved.id, { bot: { ...botTarget, resultsTo: { channel: 'C0RES' } } })
    ).resolves.toMatchObject({ bot: { resultsTo: posted } })
    // Its own check takes the id the field keeps.
    expect(/^[CGD][A-Z0-9]+$/.test(posted.channel)).toBe(true)
    // An edit that leaves a place keeps it as saved.
    await expect(controller.update(older.id, { name: 'Renamed' })).resolves.toMatchObject({
      on: [{ in: ['C0ENG'] }]
    })
    expect(store.listAutomations()).toHaveLength(2)
  })

  it("targets the bot's folder and agent on this computer, with no project", async () => {
    const { controller, folderKey, resolvers } = await setup()

    const automation = await controller.create({ ...schedule, bot: botTarget })

    expect(automation).toMatchObject({
      agentId: 'codex',
      bot: botTarget,
      projectId: '',
      runContext: null,
      workspaceMode: 'existing',
      workspaceId: folderKey,
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service'
    })
    expect(resolvers.showRepo).not.toHaveBeenCalled()
  })

  it('leaves a project automation without a bot field', async () => {
    const { controller } = await setup()

    const automation = await controller.create({ ...schedule, repo: 'id:repo-1' })

    expect(automation).not.toHaveProperty('bot')
  })

  it('refuses a bot this host does not have', async () => {
    const { controller, store } = await setup()

    await expect(
      controller.create({ ...schedule, bot: { ...botTarget, botId: 'gone' } })
    ).rejects.toThrow('bot_not_found')
    expect(store.listAutomations()).toHaveLength(0)
  })

  it('saves nothing for a bot deleted while the save looked up its places', async () => {
    const { controller, store } = await setup()
    controller.placeRefs = () => async () => {
      store.removeBot(store.getBots()[0]!)
      return { ref: 'slack:T1:C0RES', label: '#results', key: 'C0RES' }
    }

    await expect(
      controller.create({ ...schedule, bot: { ...botTarget, resultsTo: { channel: '#results' } } })
    ).rejects.toThrow('bot_not_found')
    expect(store.listAutomations()).toHaveLength(0)
  })

  it('keeps the host-chosen Home fallback when an edit keeps the chat, and drops it when the chat changes', async () => {
    const { controller } = await setup()
    controller.botChat = async (_bot, id) => ({ title: id === 'side-chat' ? 'Deploys' : 'Other' })
    const inChat = { ...botTarget, runsIn: 'chat' as const }
    const created = await controller.create({
      ...schedule,
      bot: { ...inChat, chat: { sessionId: 'side-chat', homeIfGone: true } }
    })

    // A client edits where results go, echoing the chat without homeIfGone (the RPC strips it).
    const kept = await controller.update(created.id, {
      bot: { ...inChat, chat: { sessionId: 'side-chat' }, resultsTo: 'none' }
    })
    expect(kept.bot?.chat).toEqual({ sessionId: 'side-chat', title: 'Deploys', homeIfGone: true })

    const moved = await controller.update(created.id, {
      bot: { ...inChat, chat: { sessionId: 'other-chat' }, resultsTo: 'none' }
    })
    expect(moved.bot?.chat).toEqual({ sessionId: 'other-chat', title: 'Other' })
  })

  it('updates where results go without moving the automation', async () => {
    const { controller, folderKey } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })

    const updated = await controller.update(created.id, {
      bot: { ...botTarget, resultsTo: { channel: 'C0123' } }
    })

    expect(updated).toMatchObject({
      bot: { ...botTarget, resultsTo: { channel: 'C0123' } },
      workspaceId: folderKey,
      executionTargetType: 'local'
    })
  })

  it('records the agent its runs start on, and refuses its own agent in a chat', async () => {
    const { controller } = await setup()
    const own: AutomationBotTarget = {
      ...botTarget,
      agentSetup: { agent: 'claude', launch: { model: 'opus' } }
    }

    const created = await controller.create({ ...schedule, agentId: 'claude', bot: own })
    expect(created).toMatchObject({ agentId: 'claude', bot: own })

    await expect(
      controller.update(created.id, { bot: { ...own, runsIn: 'chat' } })
    ).rejects.toThrow("A run in a chat continues on that chat's agent")
    const back = await controller.update(created.id, { bot: botTarget })
    expect(back).toMatchObject({ agentId: 'codex', bot: botTarget })
  })

  it('refuses Antigravity as the agent on a host without Orca’s managed Antigravity server', async () => {
    const { controller, store } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })
    const onAgy: AutomationBotTarget = { ...botTarget, agentSetup: { agent: 'antigravity' } }
    const refusal =
      "Antigravity bots need Orca's own Antigravity server, which isn't available on the computer this bot runs on."
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'freebsd' })
    try {
      await expect(controller.create({ ...schedule, bot: onAgy })).rejects.toThrow(refusal)
      await expect(controller.update(created.id, { bot: onAgy })).rejects.toThrow(refusal)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(store.listAutomations()).toEqual([
      expect.objectContaining({ agentId: 'codex', bot: botTarget })
    ])
  })

  it('pauses a stored automation whose chat target still names an agent, without refusing it', async () => {
    const { controller, store, folderKey } = await setup()
    // No save path writes this; a hand-edited store can.
    const stored = store.createAutomation({
      ...schedule,
      bot: { ...botTarget, runsIn: 'chat', agentSetup: { agent: 'claude' } },
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: folderKey
    })

    await expect(controller.update(stored.id, { enabled: false })).resolves.toMatchObject({
      enabled: false,
      agentId: 'codex'
    })
  })

  it("refuses settings the bot's own agent and session would ignore", async () => {
    const { controller } = await setup()
    const message = "A bot automation runs with the bot's own agent, session and folder."

    await expect(
      controller.create({ ...schedule, bot: botTarget, extraAgentArgs: '--model opus' })
    ).rejects.toThrow(message)
    await expect(
      controller.create({ ...schedule, bot: botTarget, repo: 'id:repo-1' })
    ).rejects.toThrow(message)
    const created = await controller.create({ ...schedule, bot: botTarget })
    await expect(controller.update(created.id, { agentId: 'claude' })).rejects.toThrow(message)
    await expect(controller.update(created.id, { reuseSession: true })).rejects.toThrow(message)
  })

  it("checks the agent against the bot's current agent, not the saved one", async () => {
    const { controller, store } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })
    store.saveBot(makeTestBot({ ...store.getBots()[0], agent: 'claude' }))

    const updated = await controller.update(created.id, { agentId: 'claude' })

    expect(updated.agentId).toBe('claude')
  })

  it('still pauses an automation whose bot was deleted', async () => {
    const { controller, store } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })
    store.removeBot(store.getBots()[0]!)

    await expect(controller.update(created.id, { enabled: false })).resolves.toMatchObject({
      enabled: false
    })
  })

  it('keeps a bot automation on this computer under a destination fence', async () => {
    const { controller } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })

    const renamed = await controller.update(
      created.id,
      { name: 'Evening digest' },
      { destination: { selector: { kind: 'self' } } }
    )

    expect(renamed).toMatchObject({ name: 'Evening digest', executionTargetType: 'local' })
  })

  it('refuses an event from a source the bot has no connector for, on create and edit', async () => {
    const { controller, store } = await setup()
    const ciFailed = {
      id: 'on-1',
      source: 'github',
      event: 'ci_failed'
    } as const
    const message = 'Reviewer has no GitHub connector, so github.ci_failed would never start it.'

    await expect(
      controller.create({ ...schedule, bot: botTarget, on: [ciFailed] })
    ).rejects.toThrow(message)
    const created = await controller.create({ ...schedule, bot: botTarget })
    await expect(controller.update(created.id, { on: [ciFailed] })).rejects.toThrow(message)

    store.saveBot(makeTestBot({ ...store.getBots()[0], github: {} }))
    await expect(controller.update(created.id, { on: [ciFailed] })).resolves.toMatchObject({
      on: [ciFailed]
    })
  })

  it('refuses to move an automation between a bot and a project', async () => {
    const { controller } = await setup()
    const asBot = await controller.create({ ...schedule, bot: botTarget })
    const asProject = await controller.create({ ...schedule, repo: 'id:repo-1' })

    await expect(controller.update(asBot.id, { repo: 'id:repo-1' })).rejects.toThrow(
      'An automation cannot move between a bot and a project.'
    )
    await expect(controller.update(asProject.id, { bot: botTarget })).rejects.toThrow(
      'An automation cannot move between a bot and a project.'
    )
  })

  it('saves mobile edits and preserves explicit and inherited timezones', async () => {
    const { controller, store } = await setup()
    const operations = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: controller.create.bind(controller),
      updateAutomation: controller.update.bind(controller)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These mobile methods only use the runtime ID and automation writes.
    const runtime = operations as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const dispatch = (method: string, params: unknown) =>
      dispatcher.dispatch(
        { id: 'req-1', authToken: 'tok', method, params },
        { callerScope: { kind: 'mobile' } }
      )

    await expect(
      dispatch('automation.create', {
        ...schedule,
        bot: botTarget,
        timezone: 'Europe/London',
        timezoneExplicit: true
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      dispatch('automation.create', {
        ...schedule,
        name: 'Inherited zone',
        repo: 'id:repo-1',
        workspaceMode: 'new_per_run'
      })
    ).resolves.toMatchObject({ ok: true })
    const saved = store.listAutomations()
    expect(saved.find((entry) => entry.name === schedule.name)).toMatchObject({
      timezone: 'Europe/London',
      timezoneExplicit: true
    })
    const inherited = saved.find((entry) => entry.name === 'Inherited zone')
    expect(inherited?.timezoneExplicit).toBeUndefined()
    const edited = {
      enabled: false,
      prompt: 'Do more',
      agentId: 'claude',
      timezone: 'Asia/Tokyo',
      timezoneExplicit: true,
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0'
    }
    await expect(
      dispatch('automation.update', { id: inherited?.id, updates: edited })
    ).resolves.toMatchObject({ ok: true })
    expect(store.listAutomations().find((entry) => entry.id === inherited?.id)).toMatchObject(
      edited
    )
  })
})
