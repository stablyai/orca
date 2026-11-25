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
import { botNeedsYouCount } from '../../../src/shared/bots/bot-now'
import {
  botRowLimit,
  type NamedUsageLimitStop
} from '../../../src/shared/bots/bot-usage-limit-stop'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import { translate } from '../i18n/mobile-i18n'
import { agentDotState, agentRowTimeAt } from '../worktree/agent-lineage/agent-row-display'
import type { MobileBotRowFacts } from './host-bot-row-facts'
import { mobileUsageLimitStopText } from './mobile-usage-limit-copy'

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

/** The bot's one Needs you count as its row holds it (`botNeedsYouCount`): its own chats and runs
 *  still asking (a stale ask has decayed, as on the desktop) and its workers on a permission, beside its
 *  items and the people asking for access. The row's badge and line both say it; the open panel's Items
 *  tab also counts what only it reads. */
export function mobileBotRowNeedsYou(
  line: Pick<MobileBotRowFacts['line'], 'workers' | 'itemsNeedingYou'>,
  rows: readonly RuntimeWorktreeAgentRow[],
  now: number
): number {
  const asking = rows.filter((row) => {
    const dot = agentDotState(row, now)
    return dot === 'blocked' || dot === 'waiting'
  }).length
  return botNeedsYouCount(asking + (line.workers?.permission ?? 0), line.itemsNeedingYou ?? 0)
}

export function mobileBotRowLine(
  bot: Pick<MobileBotRowFacts, 'paused' | 'line'>,
  rows: readonly RuntimeWorktreeAgentRow[],
  now: number
): BotRowLine | null {
  return selectBotRowLine(
    {
      ...bot.line,
      paused: bot.paused,
      rows,
      needsYou: mobileBotRowNeedsYou(bot.line, rows, now),
      now
    },
    PHONE_ROWS
  )
}

/** The line's words, as the desktop's row says them. */
export function mobileBotRowLineText(line: BotRowLine, now: number): string {
  return botRowLineText(line, translate, (by) =>
    new Intl.DateTimeFormat(undefined, botWaitTimeFormat(by, now)).format(by)
  )
}

/** The usage-limit line, said in place of a quiet line; null while the bot or a worker works or
 *  asks. Its own Home Chat goes unnamed: tapping the row opens it. */
export function mobileBotRowLimitText(
  stop: NamedUsageLimitStop | null,
  line: BotRowLine | null,
  bot: {
    dot: BotRowStatus | null
    workers?: MobileBotRowFacts['line']['workers']
    chatSessionId: string | null | undefined
  },
  now: number
): string | null {
  const { dot, workers } = bot
  const busy =
    dot === 'working' ||
    dot === 'permission' ||
    (workers?.working ?? 0) > 0 ||
    (workers?.permission ?? 0) > 0
  const limit = botRowLimit(stop, line, busy, bot.chatSessionId, translate)
  if (!limit) {
    return null
  }
  const place = limit.stop.sessionId === bot.chatSessionId ? null : limit.place
  return [place, mobileUsageLimitStopText(limit.stop, now)].filter(Boolean).join(' · ')
}
