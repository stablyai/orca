import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { waitForAgentPromptDelay } from './orca-runtime-core'
import type { AgentPromptTarget } from './runtime-terminal-contracts'

/** `none`: no retry applies to this prompt; `skipped`: the wait ran but no Enter was written. */
export type AgentPromptSubmitRetry = 'none' | 'skipped' | 'written'

/** Writes the one retry Enter an agent with `submitRetryDelayMs` gets after the first Enter of
 *  its launch prompt. Best-effort: a refused guard or failed write skips it, never fails the send. */
export async function writeAgentPromptSubmitRetry(args: {
  target: AgentPromptTarget | undefined
  agent: TuiAgent | null | undefined
  signal?: AbortSignal
  /** The same pre-write guards the first Enter passed; throwing skips the retry. */
  assertWritable: () => Promise<void>
  write: (data: string) => boolean
}): Promise<AgentPromptSubmitRetry> {
  // Why launch-only: Codex discards Enter for a short, load-dependent window after its composer
  // first renders. A running agent is past that window, and an extra Enter there could answer an
  // approval or pick a slash-command entry; after a successful submit it lands on an empty composer.
  const delayMs =
    args.target === 'just-launched-agent' && args.agent
      ? TUI_AGENT_CONFIG[args.agent]?.submitRetryDelayMs
      : undefined
  if (delayMs === undefined) {
    return 'none'
  }
  try {
    await waitForAgentPromptDelay(delayMs, args.signal)
    await args.assertWritable()
    return args.write(AGENT_PROMPT_SUBMIT) ? 'written' : 'skipped'
  } catch {
    return 'skipped'
  }
}
