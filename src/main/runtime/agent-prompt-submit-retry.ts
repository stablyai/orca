import { AGENT_PROMPT_SUBMIT } from '../../shared/agent-prompt-injection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { waitForAgentPromptDelay } from './orca-runtime-core'

/** Writes the one retry Enter an agent with `submitRetryDelayMs` gets after its first Enter.
 *  Best-effort: a refused guard or failed write skips the retry and never fails the send. */
export async function writeAgentPromptSubmitRetry(args: {
  agent: TuiAgent | null | undefined
  signal?: AbortSignal
  /** The same pre-write guards the first Enter passed; throwing skips the retry. */
  assertWritable: () => Promise<void>
  write: (data: string) => boolean
}): Promise<boolean> {
  const delayMs = args.agent ? TUI_AGENT_CONFIG[args.agent]?.submitRetryDelayMs : undefined
  if (delayMs === undefined) {
    return false
  }
  try {
    // Why: Codex discards Enter for a short, load-dependent window after its composer first
    // renders, and a host send can land on a just-booted Codex (worker start). An Enter on the
    // empty composer after a successful submit is a no-op, so the retry is unconditional.
    await waitForAgentPromptDelay(delayMs, args.signal)
    await args.assertWritable()
    return args.write(AGENT_PROMPT_SUBMIT)
  } catch {
    return false
  }
}
