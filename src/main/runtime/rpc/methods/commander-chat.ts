import { HANDOFF_GOAL_LIMIT } from '../../../../shared/commander/goal-handoff'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'
import { hostBotAgentChoices } from './bots-agent-choices'

function requireCommanderOwner(context: RpcContext): void {
  if (!context.caller) {
    throw new InvalidArgumentError('An authenticated Orca desktop or paired device is required.')
  }
  ownerOnly(context, 'Only the owner can open Commander Chat.')
}

export const COMMANDER_CHAT_OPEN = defineMethod({
  name: 'commanderChat.open',
  permission: 'workspace',
  params: null,
  handler: async (_params, context) => {
    requireCommanderOwner(context)
    const { runtime } = context
    const bot = await runtime.bots.ensureCommander(async () => {
      const choices = await hostBotAgentChoices(runtime)
      const preferred = runtime.requireStore().getSettings().defaultTuiAgent
      const agent = choices.find((candidate) => candidate === preferred) ?? choices[0]
      if (!agent) {
        throw new InvalidArgumentError(
          'Set up a chat agent such as Codex or Claude on this host, then open Commander again.'
        )
      }
      return agent
    })
    return { bot }
  }
})

/** The same bounded, durable turn preview shown by Orca's chat list. Read only the home conversation. */
export const COMMANDER_CHAT_RECENT = defineMethod({
  name: 'commanderChat.recent',
  permission: 'workspace',
  params: null,
  handler: async (_params, context) => {
    requireCommanderOwner(context)
    const { runtime } = context
    const empty = { goal: '', progress: '' }
    const store = runtime.requireStore()
    const commander = () => store.getBots?.().find((bot) => bot.systemRole === 'commander')
    const bot = commander()
    if (!bot?.chatSessionId) {
      return empty
    }
    await runtime.ensureStructuredAgentSessionHost()
    const current = commander()
    if (
      runtime.requireStore() !== store ||
      current?.id !== bot.id ||
      current.chatSessionId !== bot.chatSessionId ||
      current.folderWorkspaceId !== bot.folderWorkspaceId
    ) {
      return empty
    }
    const live = resolveLineageRunningSession(readAgentSessionRecordStore(), bot.chatSessionId)
    if (live.kind !== 'here' || !botOfHomeWorkspace([bot], live.record.location.workspaceId)) {
      return empty
    }
    const turn = live.record.lastTurn
    if (!turn?.prompt?.trim()) {
      return empty
    }
    const goal = turn.prompt
      .trim()
      .slice(0, HANDOFF_GOAL_LIMIT)
      .replace(/[\uD800-\uDBFF]$/, '')
    const progress =
      turn.state === 'settled' ? (turn.reply ?? '').trim().replace(/[\uD800-\uDBFF]$/, '') : ''
    return { goal, progress }
  }
})
