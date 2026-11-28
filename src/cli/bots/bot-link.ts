import type { BotLinkResult } from '../../shared/rpc-contract/bots-link-params'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { callerChat } from '../automations/automation-caller-chat'
import { getRequiredWorktreeSelector } from '../workspace-selection/workspace-selector'
import { callBots, findBot } from './bot'

export function formatBotLink(result: BotLinkResult): string {
  return `Link to ${result.workspaceName} (opens in Orca on whichever computer or phone it is clicked): ${result.link}`
}

export const BOT_LINK_HANDLERS: Record<string, CommandHandler> = {
  'bot link': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const agentSessionId = getOptionalStringFlag(flags, 'agent')
    const result = await callBots<BotLinkResult>(client, 'bots.link', {
      ...callerChat(),
      worktree,
      ...(botId ? { botId } : {}),
      ...(agentSessionId ? { agentSessionId } : {})
    })
    printResult(result, json, formatBotLink)
  }
}
