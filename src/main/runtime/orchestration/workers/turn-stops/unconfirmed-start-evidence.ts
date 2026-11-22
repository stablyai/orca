import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalPromptSubmit
} from '../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type {
  AgentPromptAftermath,
  AgentStatusReport
} from '../../../terminal/input/agent-prompt-aftermath'

/** How a start's brief went in: when the agent was ready, and the receipt of its write. */
export type UnconfirmedStartDelivery = {
  readyAt: number
  prompt: RuntimeTerminalPromptDelivery | undefined
}

const RENDER_WAIT_WORDS: Record<NonNullable<RuntimeTerminalPromptSubmit['renderWait']>, string> = {
  quiet: 'once its screen went quiet',
  draft: 'once the brief showed in its prompt',
  cap: "at the wait's limit, while its screen kept changing"
}

const REPORT_WORDS: Record<AgentStatusReport['status'], string> = {
  working: 'working',
  permission: 'waiting for a person',
  idle: 'at rest'
}

/** What a start-unconfirmed alert says of how the brief went in; a withheld Enter changes its advice. */
export type UnconfirmedStartEvidence = {
  lines: string[]
  withheldFor?: RuntimeTerminalWaitBlockedReason
}

/** What tells a lost Enter, a dialog that took it, and a turn Orca missed apart. */
export function describeUnconfirmedStartEvidence(
  delivery: UnconfirmedStartDelivery,
  aftermath: AgentPromptAftermath | null
): UnconfirmedStartEvidence | undefined {
  const submit = delivery.prompt?.submit
  if (!submit) {
    return undefined
  }
  const typed = `Orca typed the brief ${seconds(submit.pastedAt - delivery.readyAt)} after the agent was ready`
  if ('withheldFor' in submit) {
    if (aftermath?.processReplaced) {
      // The dialog was the old process's; the new one's screen decides what Enter does now.
      return {
        lines: [
          `${typed}, but did not press Enter: a dialog showed on its screen (${submit.withheldFor}).`,
          describeAftermath(aftermath, submit.pastedAt)
        ]
      }
    }
    return {
      lines: [
        `${typed}, but did not press Enter: a dialog showed on its screen (${submit.withheldFor}).`
      ],
      withheldFor: submit.withheldFor
    }
  }
  const wait = submit.renderWait ? ` ${RENDER_WAIT_WORDS[submit.renderWait]}` : ''
  return {
    lines: [
      `${typed} and pressed Enter ${seconds(submit.enteredAt - submit.pastedAt)} later${wait}.`,
      ...(aftermath ? [describeAftermath(aftermath, submit.enteredAt)] : [])
    ]
  }
}

function describeAftermath(aftermath: AgentPromptAftermath, enteredAt: number): string {
  if (aftermath.processReplaced) {
    return 'Its terminal now runs a different process than the one the brief went to.'
  }
  const seen = aftermath.turnStarted
    ? 'a turn has started'
    : aftermath.permissionSeen
      ? 'no turn has started, but a permission prompt showed'
      : 'no turn start has been seen'
  const report = aftermath.lastReport
  const last = report
    ? `its last status report was ${REPORT_WORDS[report.status]}, ${seconds(Math.abs(report.at - enteredAt))} ${report.at < enteredAt ? 'before' : 'after'} the Enter`
    : 'it has sent no status report'
  return `Since the Enter, ${seen}; ${last}.`
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
}
