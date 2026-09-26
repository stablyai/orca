import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'

/**
 * Headless dispatch used to call `waitForTerminal({ condition: 'tui-idle' })`
 * with no `timeoutMs`, so it inherited the runtime's 5-minute default and marked
 * longer agent runs as `dispatch_failed` / `timeout` while the agent was still
 * working (#22725). Route through the same observer retained runs use so each
 * tui-idle timeout re-arms until the shared 6h deadline.
 */
export function createHeadlessAutomationCompletion(args: {
  observeCompletion: AutomationRunTerminalObserver['observeCompletion']
  terminalHandle: string
  signal: AbortSignal
}): Promise<AutomationRunCompletionObservation> {
  return args.observeCompletion(args.terminalHandle, {
    signal: args.signal
  })
}
