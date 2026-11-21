// The item salvage asks with: the lines word for word, each with its journal month and any later
// line that may replace it, and a question with two quick replies. The owner may also type numbers.
import type { BotItemAsk } from '../../shared/bots/bot-item-ask'

export const SALVAGE_KEEP_ALL = 'Keep all'
export const SALVAGE_KEEP_NONE = 'Keep none'

export type SalvageOffered = { line: string; month: string; replacedBy: string | null }

/** Inline code that no line can close: a run of backticks longer than any inside it. */
function quoted(line: string): string {
  const longest = Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence} ${line} ${fence}`
}

export function salvageProposalText(offered: readonly SalvageOffered[]): {
  title: string
  description: string
  ask: BotItemAsk
} {
  const count = offered.length
  const lines = offered.flatMap(({ line, month, replacedBy }, index) => [
    `${index + 1}. ${quoted(line)} (journal ${month})`,
    ...(replacedBy ? [`   Possibly replaced later by: ${quoted(replacedBy)}`] : [])
  ])
  return {
    title:
      count === 1
        ? 'Keep a possible decision of yours in memory?'
        : `Keep ${count} possible decisions of yours in memory?`,
    description: [
      "Tidy-up moved these lines out of MEMORY.md into the bot's journal because they mention work in progress. They read like decisions you made, so they may belong in memory.",
      "Each line is the bot's own note, quoted from its journal word for word. It matched a pattern, which doesn't mean you said it.",
      '',
      ...lines,
      '',
      'Orca puts back exactly the lines you keep and changes nothing else. Nothing changes until you answer.'
    ].join('\n'),
    ask: {
      context: `Answer ${SALVAGE_KEEP_ALL}, ${SALVAGE_KEEP_NONE}, or the numbers to keep, like "1, 3".`,
      questions: [
        {
          prompt: 'Keep these lines in memory?',
          options: [{ label: SALVAGE_KEEP_ALL }, { label: SALVAGE_KEEP_NONE }]
        }
      ]
    }
  }
}

export const SALVAGE_REASK: BotItemAsk = {
  context: `That answer couldn't be read, so nothing was kept. Answer ${SALVAGE_KEEP_ALL}, ${SALVAGE_KEEP_NONE}, or only numbers, like "1, 3".`,
  questions: [
    {
      prompt: 'Keep these lines in memory?',
      options: [{ label: SALVAGE_KEEP_ALL }, { label: SALVAGE_KEEP_NONE }]
    }
  ]
}

export const SALVAGE_NOTES = {
  kept: (kept: number, unrestorable: number) =>
    unrestorable === 0
      ? `Kept ${kept} in memory.`
      : `Kept ${kept} in memory; ${unrestorable} could not be put back as written.`,
  unread: "The answer couldn't be read twice, so nothing was kept.",
  expired: 'No answer in 14 days. These lines will be offered again.'
} as const
