// A bot row's second line on the phone: the desktop's pick (`selectBotRowLine`), read from the bot
// home's agent rows as the phone's list reports them.
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import {
  botRowLineText,
  botWaitTimeFormat,
  selectBotRowLine,
  type BotRowLine,
  type BotRowLineReader
} from '../../../src/shared/bots/bot-row-line'
import { compactAgentStatusLine } from '../../../src/shared/agent-status/presentation/agent-compact-status'
import { resolveProgramStatusPresentation } from '../../../src/shared/program-status/presentation'
import { translate } from '../i18n/mobile-i18n'
import { agentRowTimeAt } from '../worktree/agent-lineage/agent-row-display'
import type { MobileBotRowFacts } from './host-bot-row-facts'

const PHONE_ROWS: BotRowLineReader<RuntimeWorktreeAgentRow> = {
  paneKey: (row) => row.paneKey,
  // Each host row is a pane of its own; provider subagents nest inside it.
  subagent: () => false,
  live: (row) => row.state === 'working' || row.state === 'blocked' || row.state === 'waiting',
  needsYou: (row) => row.state === 'blocked' || row.state === 'waiting',
  updatedAt: (row) => row.updatedAt,
  // What the agent itself said, as the desktop's compact row reads it; nothing yet reads as replying.
  status: (row, now) => {
    // The host's wire sends null where the status entry leaves a field out.
    const entry = {
      ...row,
      agentType: row.agentType ?? undefined,
      toolName: row.toolName ?? undefined,
      toolInput: row.toolInput ?? undefined,
      lastAssistantMessage: row.lastAssistantMessage ?? undefined
    }
    return compactAgentStatusLine({
      entry,
      state: row.state,
      presentation: resolveProgramStatusPresentation(entry),
      now,
      labels: {
        stopping: translate('worktree.agentRowDisplay.stopping', 'Stopping…'),
        monitoring: translate('worktree.agentRowDisplay.monitoring', 'Monitoring background tasks')
      }
    })
  },
  at: (row) => agentRowTimeAt(row)
}

export function mobileBotRowLine(
  bot: Pick<MobileBotRowFacts, 'paused' | 'line'>,
  rows: readonly RuntimeWorktreeAgentRow[],
  now: number
): BotRowLine | null {
  return selectBotRowLine({ ...bot.line, paused: bot.paused, rows, now }, PHONE_ROWS)
}

/** The line's words, as the desktop's row says them. */
export function mobileBotRowLineText(line: BotRowLine, now: number): string {
  return botRowLineText(line, translate, (by) =>
    new Intl.DateTimeFormat(undefined, botWaitTimeFormat(by, now)).format(by)
  )
}
