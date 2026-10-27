import { BROWSER_WAIT_DEFAULT_TIMEOUT_MS } from '../../shared/browser-wait-timeout'

// Lets agent-browser report its own wait timeout before Orca kills the process.
const WAIT_PROCESS_TIMEOUT_GRACE_MS = 5_000

export type AgentBrowserWaitOptions = {
  selector?: string
  timeout?: number
  text?: string
  url?: string
  load?: string
  fn?: string
  state?: string
}

export function agentBrowserWaitArguments(options: AgentBrowserWaitOptions): {
  args: string[]
  conditionTimeoutMs?: number
  processTimeoutMs?: number
} {
  if (!options.selector && !options.text && !options.url && !options.load && !options.fn) {
    return {
      args: options.timeout == null ? ['wait'] : ['wait', String(options.timeout)]
    }
  }
  const args = ['wait']
  if (options.selector) {
    args.push(options.selector)
  }
  for (const [value, flag] of [
    [options.text, '--text'],
    [options.url, '--url'],
    [options.load, '--load'],
    [options.fn, '--fn'],
    [options.state === 'visible' ? undefined : options.state, '--state']
  ] as const) {
    if (value) {
      args.push(flag, value)
    }
  }
  // Why: without --timeout agent-browser stops at its own default, whatever Orca was asked for.
  const conditionTimeoutMs = options.timeout ?? BROWSER_WAIT_DEFAULT_TIMEOUT_MS
  args.push('--timeout', String(conditionTimeoutMs))
  return {
    args,
    conditionTimeoutMs,
    processTimeoutMs: conditionTimeoutMs + WAIT_PROCESS_TIMEOUT_GRACE_MS
  }
}
