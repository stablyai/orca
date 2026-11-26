import { expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { AGENT_SESSION_SELECT_PROVIDER_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import type { NewChatPermissionSettings } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { applyBotUpdates, BotUpdate } from '../../../../shared/rpc-contract/bots-params'
import { InvalidArgumentError, type RpcContext } from '../core'
import { BOT_AGENT_SWITCH_PREVIEW_METHOD, updateBotWithAgentSwitch } from './bots-agent-switch'

vi.mock('../../../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => ({ deps: { store: { getConversation: () => null } } }),
  runtimeBotChats: () => ({ withDefaultChange: (_id: string, work: () => unknown) => work() })
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
