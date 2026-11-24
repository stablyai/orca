import { formatBotWorkList, type BotWorkListResult } from '../../shared/bots/bot-work-list'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { WORKTREE_PS_SINCE_READ_LIMIT } from '../workspaces/worktree-ps-recent'
import { readWorktreePsAcrossServers } from '../workspaces/worktree-ps-fleet'
import { agentStateWords, worktreePsOpenAgent } from '../workspaces/worktree-ps-format'
import { printResult } from '../output/command-result-output'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'

/** The workspaces `worktree ps` shows under the bot: its workers' and the ones handed to it. */
async function workspacesUnder(
  client: RuntimeClient,
  botName: string
): Promise<BotWorkListResult['workspaces']> {
  const ps = await readWorktreePsAcrossServers(client, {
    limit: WORKTREE_PS_SINCE_READ_LIMIT
  }).catch(() => null)
  return ps?.result.worktrees
    .filter((row) => row.bot === botName && !row.botHome)
    .map((row) => {
      const agent = worktreePsOpenAgent(row)
      return {
        id: row.worktreeId,
        name: row.displayName,
        agent: agent ? `agent ${agentStateWords(agent.state)}` : null
      }
    })
}

export const BOT_WORK_HANDLERS: Record<string, CommandHandler> = {
  'bot work list': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const all = flags.has('all')
    const result = await callBots<BotWorkListResult>(client, 'bots.work.list', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(all ? { all } : {})
    })
    if (all && result.result.historyIncluded !== true) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This server does not support bot work list --all. Update Orca on it to include closed work.'
      )
    }
    const workspaces = await workspacesUnder(client, result.result.botName)
    printResult({ ...result, result: { ...result.result, workspaces } }, json, (value) =>
      formatBotWorkList(value, Date.now())
    )
  },
  'bot work forget': async ({ client, json }) => {
    const result = await callBots<{ forgotten: boolean }>(client, 'bots.work.forget', callerChat())
    printResult(result, json, (value) =>
      value.forgotten
        ? "Forgot this conversation's work; its next request starts fresh."
        : 'This conversation had no work to forget.'
    )
  }
}
