import { expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import type { NewChatPermissionSettings } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { applyBotUpdates, BotUpdate } from '../../../../shared/rpc-contract/bots-params'
import { selectBotProviderFromComposer } from '../../../bots/bot-composer-provider-switch'
import { InvalidArgumentError, type RpcContext } from '../core'
import { BOT_AGENT_SWITCH_PREVIEW_METHOD, updateBotWithAgentSwitch } from './bots-agent-switch'

type FakeRecord = {
  sessionId: string
  provider: string
  permissionMode?: string
  location: { workspaceId: string }
  selectedProvider?: { agent: string; options?: Record<string, string>; botDefault?: string } | null
}

let activeHost: {
  deps: {
    store: {
      getConversation: (id: string) => FakeRecord | null
      getRecord?: (id: string) => FakeRecord | null
      listConversations?: () => FakeRecord[]
      updateRecord?: (
        id: string,
        mutation: { selection: FakeRecord['selectedProvider'] }
      ) => Promise<void>
    }
  }
  selectProvider?: (
    params: {
      sessionId: string
      agent: string
      options?: Record<string, string>
      consent?: unknown
    },
    botDefault?: { botId: string; save: () => Promise<void> }
  ) => Promise<{ status: 'selected' }>
} = {
  deps: { store: { getConversation: () => null } }
}

vi.mock('../../../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => activeHost,
  runtimeBotChats: () => ({ withDefaultChange: (_id: string, work: () => unknown) => work() })
}))

vi.mock('../../../bots/bot-group-runtime', () => ({
  captureBotGroupPreConsentOperations: vi.fn(async () => {}),
  runtimeBotGroups: () => ({
    store: {
      memberOf: (sessionId: string) =>
        sessionId.startsWith('bot-group-member-active-')
          ? { member: { botId: 'bot-1', sessionId } }
          : null
    }
  })
}))

vi.mock('../../../bots/bot-own-skills', () => ({
  linkBotOwnSkills: vi.fn(async () => {})
}))

function rig() {
  let bot = makeTestBot({ agent: 'claude', permissionMode: undefined })
  const settings: NewChatPermissionSettings = {
    agentPermissionDefault: 'ask',
    agentPermissionOverrides: { codex: 'full-access' }
  }
  const runtime = {
    requireStore: () => ({ getSettings: () => settings }),
    bots: {
      list: () => [bot],
      update: async (
        ...[, edit, switchAgent]: Parameters<RpcContext['runtime']['bots']['update']>
      ) => {
        const next = applyBotUpdates(bot, typeof edit === 'function' ? edit(bot) : edit)
        const save = async () => {
          bot = next
        }
        await (switchAgent && next.agent !== bot.agent ? switchAgent(bot, next, save) : save())
        return bot
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bot switching only reads the supplied settings and bot methods.
  const context = { runtime } as unknown as RpcContext
  return {
    read: () => bot,
    settings,
    preview: () =>
      BOT_AGENT_SWITCH_PREVIEW_METHOD.handler({ botId: bot.id, agent: 'codex' }, context),
    update: (updates: unknown, capable: boolean) =>
      updateBotWithAgentSwitch(
        BotUpdate.parse({ botId: bot.id, updates }),
        capable
          ? { ...context, clientCapabilities: [AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY] }
          : context
      )
  }
}

it('refuses a legacy agent change before saving any portion of the request', async () => {
  const bot = rig()
  const original = bot.read()
  await expect(bot.update({ agent: 'codex', name: 'Renamed' }, false)).rejects.toThrow(
    new InvalidArgumentError('Update Orca before switching this bot’s agent.')
  )
  expect(bot.read()).toBe(original)
  expect(await bot.update({ agent: 'claude', name: 'Renamed' }, false)).toMatchObject({
    agent: 'claude',
    name: 'Renamed'
  })
})

it('requires disclosure before fixing inherited permissions and preserves the saved Ask on return', async () => {
  const bot = rig()
  expect(await bot.preview()).toEqual({ consent: null, saveExplicitAsk: true })
  await expect(bot.update({ agent: 'codex' }, true)).rejects.toThrow(
    'confirm the agent switch again'
  )
  expect(bot.read()).toMatchObject({ agent: 'claude', permissionMode: undefined })
  expect(
    await bot.update({ agent: 'codex', agentSwitchSaveExplicitAsk: true }, true)
  ).toMatchObject({
    agent: 'codex',
    permissionMode: 'ask'
  })
  bot.settings.agentPermissionDefault = 'full-access'
  expect(await bot.update({ agent: 'claude' }, true)).toMatchObject({
    agent: 'claude',
    permissionMode: 'ask'
  })

  const unchanged = rig()
  unchanged.settings.agentPermissionOverrides = { codex: 'ask' }
  expect(await unchanged.preview()).toEqual({ consent: null })
  await expect(
    unchanged.update({ agent: 'codex', agentSwitchSaveExplicitAsk: true }, true)
  ).rejects.toThrow('confirm the agent switch again')
  expect((await unchanged.update({ agent: 'codex' }, true)).permissionMode).toBeUndefined()
})

function multiInstanceRig() {
  let bot = makeTestBot({
    id: 'bot-1',
    agent: 'claude',
    permissionMode: 'ask',
    folderWorkspaceId: 'folder-bot-1',
    chatSessionId: 'home-session'
  })
  const botWorkspace = folderWorkspaceKey(bot.folderWorkspaceId)
  const otherWorkspace = folderWorkspaceKey('folder-other-bot')
  const records = new Map<string, FakeRecord>([
    [
      'home-session',
      {
        sessionId: 'home-session',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: botWorkspace }
      }
    ],
    [
      'bot-group-member-active-room',
      {
        sessionId: 'bot-group-member-active-room',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: botWorkspace }
      }
    ],
    [
      'bot-group-member-active-thread',
      {
        sessionId: 'bot-group-member-active-thread',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: botWorkspace }
      }
    ],
    [
      'bot-group-member-retired',
      {
        sessionId: 'bot-group-member-retired',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: botWorkspace }
      }
    ],
    [
      'slack-thread-session',
      {
        sessionId: 'slack-thread-session',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: botWorkspace }
      }
    ],
    [
      'unrelated-session',
      {
        sessionId: 'unrelated-session',
        provider: 'claude',
        permissionMode: 'ask',
        location: { workspaceId: otherWorkspace }
      }
    ]
  ])
  const selectedCalls: {
    sessionId: string
    agent: string
    options?: Record<string, string>
    consent?: unknown
    botId?: string
  }[] = []
  activeHost = {
    deps: {
      store: {
        getConversation: (id) => records.get(id) ?? null,
        getRecord: (id) => records.get(id) ?? null,
        listConversations: () => [...records.values()],
        updateRecord: async (id, mutation) => {
          const rec = records.get(id)
          if (rec) {
            rec.selectedProvider = mutation.selection
          }
        }
      }
    },
    selectProvider: async (params, botDefault) => {
      selectedCalls.push({ ...params, botId: botDefault?.botId })
      const rec = records.get(params.sessionId)
      if (rec) {
        rec.selectedProvider = {
          agent: params.agent,
          ...(params.options ? { options: params.options } : {}),
          ...(botDefault ? { botDefault: botDefault.botId } : {})
        }
      }
      await botDefault?.save()
      return { status: 'selected' }
    }
  }
  const settings: NewChatPermissionSettings = {
    agentPermissionDefault: 'ask',
    agentPermissionOverrides: { codex: 'full-access' }
  }
  const runtime = {
    requireStore: () => ({ getSettings: () => settings }),
    getOrchestrationDb: () => ({}),
    bots: {
      list: () => [bot],
      update: async (
        ...[, edit, switchAgent]: Parameters<RpcContext['runtime']['bots']['update']>
      ) => {
        const next = applyBotUpdates(bot, typeof edit === 'function' ? edit(bot) : edit)
        const save = async () => {
          bot = next
        }
        await (switchAgent && next.agent !== bot.agent ? switchAgent(bot, next, save) : save())
        return bot
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test runtime implements the methods exercised by bot switching.
  const context = {
    runtime,
    clientCapabilities: [AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY]
  } as unknown as RpcContext
  return {
    read: () => bot,
    setBot: (next: typeof bot) => {
      bot = next
    },
    records,
    selectedCalls,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test runtime implements the methods exercised by bot switching.
    runtime: runtime as unknown as Parameters<typeof selectBotProviderFromComposer>[0],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test host implements the store and selectProvider methods exercised by bot switching.
    host: activeHost as unknown as Parameters<typeof selectBotProviderFromComposer>[1],
    preview: (agent: 'codex' | 'pi') =>
      BOT_AGENT_SWITCH_PREVIEW_METHOD.handler({ botId: bot.id, agent }, context),
    update: (updates: unknown) =>
      updateBotWithAgentSwitch(BotUpdate.parse({ botId: bot.id, updates }), context)
  }
}

it('propagates Bot Settings switch to Home, local group room/thread, and external chats while skipping retired and unrelated sessions', async () => {
  const testRig = multiInstanceRig()
  const preview = await testRig.preview('pi')
  expect(preview.consent).toMatchObject({
    agent: 'pi',
    from: 'claude',
    home: { sessionId: 'home-session', from: 'claude', permission: 'ask' },
    sessions: [
      { sessionId: 'bot-group-member-active-room', from: 'claude', permission: 'ask' },
      { sessionId: 'bot-group-member-active-thread', from: 'claude', permission: 'ask' },
      { sessionId: 'slack-thread-session', from: 'claude', permission: 'ask' }
    ]
  })
  await expect(testRig.update({ agent: 'pi' })).rejects.toThrow('without Orca approval')
  await testRig.update({ agent: 'pi', agentSwitchConsent: preview.consent })
  expect(testRig.read().agent).toBe('pi')
  expect(testRig.selectedCalls.map((call) => call.sessionId).sort()).toEqual([
    'bot-group-member-active-room',
    'bot-group-member-active-thread',
    'home-session',
    'slack-thread-session'
  ])
  expect(testRig.records.get('bot-group-member-retired')?.selectedProvider).toBeUndefined()
  expect(testRig.records.get('unrelated-session')?.selectedProvider).toBeUndefined()
  expect(testRig.selectedCalls.every((call) => call.botId === 'bot-1')).toBe(true)
})

it('propagates a group composer switch across all bot instances and clamps inherited broadening permissions', async () => {
  const testRig = multiInstanceRig()
  testRig.setBot({ ...testRig.read(), permissionMode: undefined })
  const result = await selectBotProviderFromComposer(
    testRig.runtime,
    testRig.host,
    testRig.read(),
    {
      sessionId: 'bot-group-member-active-room',
      agent: 'codex',
      options: { model: 'gpt-5-codex', effort: 'high' }
    }
  )
  expect(result).toEqual({ status: 'selected' })
  expect(testRig.read()).toMatchObject({
    agent: 'codex',
    permissionMode: 'ask',
    launch: { model: 'gpt-5-codex', options: { effort: 'high' } }
  })
  expect(testRig.selectedCalls.map((call) => call.sessionId).sort()).toEqual([
    'bot-group-member-active-room',
    'bot-group-member-active-thread',
    'home-session',
    'slack-thread-session'
  ])
  for (const call of testRig.selectedCalls) {
    expect(call.options).toEqual({ model: 'gpt-5-codex', effort: 'high' })
  }

  // Switching to a provider without Orca approval controls from a side chat still requires consent across all instances.
  const needsConsent = await selectBotProviderFromComposer(
    testRig.runtime,
    testRig.host,
    testRig.read(),
    { sessionId: 'slack-thread-session', agent: 'pi' }
  )
  expect(needsConsent).toEqual({
    status: 'consent-required',
    from: 'claude',
    fromPermission: 'ask'
  })
  expect(testRig.read().agent).toBe('codex')
})
