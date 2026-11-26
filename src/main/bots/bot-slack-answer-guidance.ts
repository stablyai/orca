import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { BOT_ORCA_CLI } from './bot-preamble'

// Only the result watcher owns a run's destination and lifetime.
const slackRuns = new Map<string, (() => boolean) | undefined>()

export function keepSlackRunAnswer(runId: string, reserve?: () => boolean): () => void {
  slackRuns.set(runId, reserve)
  return () => {
    slackRuns.delete(runId)
  }
}

export function reserveSlackRunAnswer(runId: string): boolean {
  return slackRuns.get(runId)?.() ?? true
}

export function slackAnswerRoute(message: AgentJournalMessageItem): 'thread' | 'run' | null {
  if (message.automationRun && slackRuns.has(message.automationRun.runId)) {
    return 'run'
  }
  return message.connectorDelivery?.conversation.source === 'slack' ||
    message.connectorClaim?.origin.some(({ conversation }) => conversation.source === 'slack')
    ? 'thread'
    : null
}

export function botSlackAnswerGuidance(route: 'thread' | 'run'): string {
  const prepare = `Use \`${BOT_ORCA_CLI} bot reply --presentation-file <path> --prepare-final\` and use the text printed by your last successful preparation as your entire final answer.`
  const explicit =
    route === 'thread'
      ? ' For a separate in-thread update you already owe, omit --prepare-final.'
      : ''
  return [
    'For this Slack answer, use one native visual when it helps. Use a line for evenly spaced times, bars to compare categories, or a compact table for exact values. Lead with the answer. Use only words and values approved for everyone in the conversation, including external participants.',
    'Write a JSON file up to 12 KiB with v: 1, text (the short answer), and visual with kind, title and source. Use a source name or a data filename such as regional-sales.csv, without paths or links. For a bar, add axis, unit, labels and series of {label, values}. For a line, use points of {at, label} in place of labels and add a UTC window of {from, to}. For a table, use columns of {label, unit?} and rows with unique text in the first column and numbers in columns with units. A bar or table can add UTC timing of {asOf} or {from, to}.',
    prepare + explicit,
    'If a visual adds little or you cannot prepare one, give a complete shareable answer in words.'
  ].join('\n')
}
