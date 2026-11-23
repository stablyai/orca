import type { RuntimeTerminalPromptDelivery } from '../../../shared/terminal/runtime/runtime-terminal-send-contract'
import {
  classifyTerminalPromptTurnStart,
  type TerminalPromptTurnStart
} from '../../../shared/terminal/runtime/terminal-prompt-turn-start'
import { orchestrationCliName } from '../agent-view'

export type DispatchReceipt = {
  dispatch: { id: string; task_id: string; status: string; assignee_handle: string } | null
  injected?: boolean
  dryRun?: boolean
  preamble?: string
  /** The terminal write's receipt; a chat or context-only Dispatch has none. */
  prompt?: RuntimeTerminalPromptDelivery
  turnStart?: TerminalPromptTurnStart
  next?: string
}

/** A preamble typed into a terminal is not a started worker, so say what the write proved. */
export function describeDispatchTurnStart(receipt: DispatchReceipt): DispatchReceipt {
  const { prompt, dispatch } = receipt
  if (!prompt || !dispatch) {
    return receipt
  }
  const turnStart = classifyTerminalPromptTurnStart(prompt)
  // A permission prompt after Enter proves the agent took the turn, as worker-start counts it.
  if (turnStart === 'observed' || turnStart === 'permission') {
    return { ...receipt, turnStart }
  }
  const terminal = dispatch.assignee_handle
  return {
    ...receipt,
    turnStart,
    next:
      `${describeUnprovenWrite(prompt, turnStart, terminal)}. Don't dispatch again. ` +
      `If the worker doesn't start, read its screen with ` +
      `\`${orchestrationCliName()} terminal read --terminal ${terminal}\`.`
  }
}

function describeUnprovenWrite(
  prompt: RuntimeTerminalPromptDelivery,
  turnStart: TerminalPromptTurnStart,
  terminal: string
): string {
  const submit = prompt.submit
  if (submit && 'withheldFor' in submit) {
    const reason =
      submit.withheldFor === 'terminal-input'
        ? 'someone typed into it after the paste'
        : `a dialog showed on its screen (${submit.withheldFor})`
    return `The preamble was typed into ${terminal}, but Orca did not press Enter: ${reason}`
  }
  // An older host's receipt carries no submit timing, so only claim the Enter it recorded.
  const typed = `The preamble was typed into ${terminal}${submit && 'enteredAt' in submit ? ' and Enter pressed' : ''}`
  if (prompt.observation === 'incarnation_replaced') {
    return `${typed}, but the terminal's process was replaced, so its delivery is unproven`
  }
  return turnStart === 'unobserved'
    ? `${typed}, but its turn start was not seen (dispatch does not wait for one)`
    : `${typed}, but this agent cannot report a turn start`
}
