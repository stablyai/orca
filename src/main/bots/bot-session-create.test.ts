import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { structuredLaunchSeedOptions } from '../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { NewChatPermissionSettings } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  createRestTestRig,
  type RestTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { HOST_TEST_NOW } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { startBotSession } from './bot-chat-session'
import { makeTestBot } from './bot.test-fixture'
import { isWithheldOpeningMessage } from '../native-chat/agent-session-wire/acquisition/structured-agent-session-opening-withdrawal'

let rig: RestTestRig

beforeEach(async () => {
  vi.useFakeTimers({ now: HOST_TEST_NOW, toFake: ['Date'] })
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.useRealTimers()
})

it('uses the current chat default for each new session without changing existing sessions', async () => {
  const bot = makeTestBot({ permissionMode: undefined })
  const settings: NewChatPermissionSettings = { agentPermissionDefault: 'full-access' }
  const runtime = runtimeFor(bot, settings)
  const first = await startBotSession(runtime, bot)
  settings.agentPermissionDefault = 'ask'
  const second = await startBotSession(runtime, bot)

  expect(rig.store.getRecord(first)?.permissionMode).toBe('full-access')
  expect(rig.store.getRecord(second)?.permissionMode).toBe('ask')
})

it('uses Ask for a saved override the bot agent does not support', async () => {
  const bot = makeTestBot({ agent: 'codex', permissionMode: 'accept-edits' })
  const sessionId = await startBotSession(
    runtimeFor(bot, { agentPermissionDefault: 'full-access' }),
    bot
  )

  expect(rig.store.getRecord(sessionId)?.permissionMode).toBe('ask')
})

it("gives a thread's or a run's session no tab, and the Chat its tab", async () => {
  const bot = makeTestBot({ permissionMode: undefined })
  const runtime = runtimeFor(bot, {})
  const background = await startBotSession(runtime, bot, { background: true })
  const chat = await startBotSession(runtime, bot)

  expect(rig.store.getRecord(background)).not.toBeNull()
  // A restart restores only the Chat's tab.
  expect(rig.host.getPersistedVisibleSessionTabIndex().sessionIds).toEqual([chat])
  expect(vi.mocked(runtime.publishStructuredAgentSessionTab).mock.calls).toEqual([
    [expect.objectContaining({ sessionId: chat })]
  ])
})

it("hands a run's delivery check all the way down, so a refused opening message is withheld", async () => {
  const bot = makeTestBot({ permissionMode: undefined })
  const runtime = runtimeFor(bot, {})
  const refused = await startBotSession(runtime, bot, {
    background: true,
    message: { text: 'Look around', clientMessageId: 'opening-refused' },
    beforeDelivery: () => false
  })
  expect(rig.store.getRecord(refused)).not.toBeNull()
  expect(isWithheldOpeningMessage('opening-refused')).toBe(true)
  // A check that lets it through withholds nothing.
  await startBotSession(runtime, bot, {
    background: true,
    message: { text: 'Look around', clientMessageId: 'opening-kept' },
    beforeDelivery: () => true
  })
  expect(isWithheldOpeningMessage('opening-kept')).toBe(false)
})

it("refuses a run's opening message whose admission throws, through every layer", async () => {
  const bot = makeTestBot({ permissionMode: undefined })
  const refused = new Error('not_full_wake')
  await expect(
    startBotSession(runtimeFor(bot, {}), bot, {
      background: true,
      message: { text: 'Look around', clientMessageId: 'opening-unadmitted' },
      beforeFirstMessage: async () => {
        throw refused
      }
    })
  ).rejects.toThrow()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

describe.each(['claude', 'codex'] as const)("a %s bot's picked model and options", (agent) => {
  it('start each new chat on the picked model, in place of the default one and its effort', async () => {
    const bot = makeTestBot({
      agent,
      permissionMode: undefined,
      launch: { model: 'picked-model', options: { effort: 'low' } }
    })
    const sessionId = await startBotSession(
      runtimeFor(bot, { agentPermissionDefault: 'auto' }),
      bot
    )

    expect(rig.store.getRecord(sessionId)).toMatchObject({
      permissionMode: 'auto',
      options: { model: 'picked-model', effort: 'low' }
    })
  })

  it('keep a picked fast mode where the agent offers it', async () => {
    const bot = makeTestBot({
      agent,
      permissionMode: undefined,
      launch: { options: { fastMode: 'true', serviceTier: 'fast' } }
    })
    const sessionId = await startBotSession(runtimeFor(bot, {}), bot)
    const options = rig.store.getRecord(sessionId)?.options

    // Fast mode is Claude's; Codex's is its service tier.
    expect(options).toMatchObject(
      agent === 'claude' ? { fastMode: 'true' } : { serviceTier: 'fast' }
    )
  })

  it('lay a picked effort alone over the default model', async () => {
    const bot = makeTestBot({
      agent,
      permissionMode: 'ask',
      launch: { options: { effort: 'low' } }
    })
    const sessionId = await startBotSession(runtimeFor(bot, {}), bot)

    expect(rig.store.getRecord(sessionId)).toMatchObject({
      permissionMode: 'ask',
      options: { model: 'saved-model', effort: 'low' }
    })
  })
})

// Look around, tidy-up and an automation's new conversation all start this way.
describe.each(['claude', 'codex'] as const)("a %s bot's background run", (agent) => {
  it("runs on the bot's own model, never the owner's last chat pick", async () => {
    const bot = makeTestBot({
      agent,
      permissionMode: undefined,
      launch: { model: 'bot-model', options: { effort: 'low' } }
    })
    const sessionId = await startBotSession(
      runtimeFor(bot, {
        agentLaunchChoices: { [agent]: { model: 'agents-default' } }
      }),
      bot,
      { background: true }
    )

    expect(rig.store.getRecord(sessionId)?.options).toEqual({
      model: 'bot-model',
      effort: 'low'
    })
  })

  it("without the bot's own model, runs on the owner's Settings > Agents default", async () => {
    const bot = makeTestBot({ agent, permissionMode: undefined })
    const sessionId = await startBotSession(
      runtimeFor(bot, {
        agentLaunchChoices: {
          [agent]: { model: 'agents-default', options: { effort: 'low' } }
        }
      }),
      bot,
      { background: true }
    )

    expect(rig.store.getRecord(sessionId)?.options).toEqual({
      model: 'agents-default',
      effort: 'low'
    })
  })

  it("lays the bot's options over the Agents default model", async () => {
    const bot = makeTestBot({
      agent,
      permissionMode: undefined,
      launch: { options: { effort: 'low' } }
    })
    const sessionId = await startBotSession(
      runtimeFor(bot, {
        agentLaunchChoices: {
          [agent]: { model: 'agents-default', options: { effort: 'high' } }
        }
      }),
      bot,
      { background: true }
    )

    expect(rig.store.getRecord(sessionId)?.options).toEqual({
      model: 'agents-default',
      effort: 'low'
    })
  })

  it('keeps the permission default, which is not a model pick', async () => {
    const bot = makeTestBot({ agent, permissionMode: undefined })
    const sessionId = await startBotSession(
      runtimeFor(bot, { agentPermissionDefault: 'full-access' }),
      bot,
      { background: true }
    )

    expect(rig.store.getRecord(sessionId)?.permissionMode).toBe('full-access')
  })

  it('keeps chat defaults for chats and leaves an unconfigured background run to its agent', async () => {
    const bot = makeTestBot({ agent, permissionMode: undefined })
    const runtime = runtimeFor(bot, {})
    const run = await startBotSession(runtime, bot, { background: true })
    const chat = await startBotSession(runtime, bot)

    expect(rig.store.getRecord(chat)?.options).toEqual({
      model: 'saved-model',
      effort: 'high'
    })
    const background = rig.store.getRecord(run)
    expect(background?.sessionId).toBe(run)
    expect(background?.options).toBeUndefined()
  })
})

it('starts a codex bot without a saved option codex does not offer, rather than refusing it', async () => {
  const bot = makeTestBot({
    agent: 'codex',
    permissionMode: undefined,
    launch: { model: 'picked-model', options: { fastMode: 'true' } }
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const sessionId = await startBotSession(runtimeFor(bot, {}), bot)

  expect(rig.store.getRecord(sessionId)?.options).toEqual(
    expect.objectContaining({ model: 'picked-model' })
  )
  expect(rig.store.getRecord(sessionId)?.options).not.toHaveProperty('fastMode')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('fastMode'))
  warn.mockRestore()
})

type TestSettings = NewChatPermissionSettings & Pick<GlobalSettings, 'agentLaunchChoices'>

function runtimeFor(bot: Bot, settings: TestSettings): OrcaRuntimeService {
  // The owner's last pick in any chat, which a new chat they open starts on.
  const withLastPick = () => ({
    ...settings,
    nativeChatSessionOptions: {
      [bot.agent]: {
        model: 'saved-model',
        valuesByModel: { 'saved-model': { effort: 'high' } }
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the runtime methods reached by the real native-chat create path.
  return {
    ensureStructuredAgentSessionHost: vi.fn(async () => {}),
    resolveStructuredAgentSessionCreateIntent: async () => ({
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: `folder:${bot.folderWorkspaceId}`,
        workspaceKind: 'folder'
      },
      agent: bot.agent,
      provider: bot.agent,
      accountHome: {
        variable: bot.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
        path: rig.root
      },
      runtimeKind: 'native',
      options: structuredLaunchSeedOptions(withLastPick(), bot.agent)
    }),
    requireStore: () => ({ getSettings: withLastPick }),
    resolveStructuredAgentSessionLocalWorkspacePath: async () => rig.root,
    publishStructuredAgentSessionTab: vi.fn(async () => {})
  } as unknown as OrcaRuntimeService
}

describe.each(['claude', 'codex'] as const)('%s bot session permissions', (agent) => {
  it.each([
    { settings: { nativeChatPermissionMode: 'full-access' }, expected: 'full-access' },
    { settings: { agentPermissionDefault: 'ask' }, expected: 'ask' },
    { settings: { agentPermissionDefault: 'own' }, expected: 'own' },
    {
      settings: {
        agentPermissionDefault: 'full-access',
        agentPermissionOverrides: { [agent]: 'ask' }
      },
      expected: 'ask'
    }
  ] as const)('inherits the native-chat default $expected', async ({ settings, expected }) => {
    const bot = makeTestBot({ agent, permissionMode: undefined })
    const sessionId = await startBotSession(runtimeFor(bot, settings), bot)

    expect(rig.store.getRecord(sessionId)).toMatchObject({
      permissionMode: expected,
      options: { model: 'saved-model', effort: 'high' }
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it.each(['ask', 'auto', 'full-access'] as const)(
    'keeps the bot override %s over the chat default and preserves the model selection',
    async (permissionMode) => {
      const bot = makeTestBot({ agent, permissionMode })
      const sessionId = await startBotSession(
        runtimeFor(bot, { agentPermissionDefault: 'own' }),
        bot
      )

      expect(rig.store.getRecord(sessionId)).toMatchObject({
        permissionMode,
        options: { model: 'saved-model', effort: 'high' }
      })
    }
  )
})
