// agent-browser reads global options anywhere in argv and has no "--", so argv cannot carry
// user values. `batch` parses commands from stdin without that scan.
export const AGENT_BROWSER_BATCH_ARGS = ['batch', '--json'] as const

export function agentBrowserBatchInput(command: readonly string[]): string {
  // serde_json rejects lone surrogates; argv used to turn them into U+FFFD.
  return JSON.stringify([command.map((token) => token.toWellFormed())])
}

export type AgentBrowserEnvelope = { success?: boolean; data?: unknown; error?: string }

type AgentBrowserBatchEntry = { result?: unknown }

/** Parses --json output; Orca's own one-command batch reply becomes the single-command envelope. */
export function parseAgentBrowserJsonOutput(
  stdout: string,
  { cliArgv = false }: { cliArgv?: boolean } = {}
): AgentBrowserEnvelope {
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    return withoutDaemonLifecycle(parsed)
  }
  // An argv `batch` is the caller's own (`exec batch`); its steps report their own failures.
  if (cliArgv) {
    return {
      success: true,
      data: parsed.map((entry: AgentBrowserBatchEntry) => ({
        ...entry,
        result: withoutLifecycle(entry?.result)
      }))
    }
  }
  const [entry] = parsed
  return withoutDaemonLifecycle({
    success: entry?.success,
    data: entry?.result,
    error: entry?.error
  })
}

function withoutDaemonLifecycle(envelope: AgentBrowserEnvelope): AgentBrowserEnvelope {
  const data = withoutLifecycle(envelope?.data)
  return data === envelope?.data ? envelope : { ...envelope, data }
}

// agent-browser 0.31+ adds its daemon's launch bookkeeping to every reply; it is not page data.
function withoutLifecycle(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('lifecycle' in data)) {
    return data
  }
  const { lifecycle: _lifecycle, ...rest } = data
  return rest
}

/** Every snapshot form (plain, --full, --delta) answers with `snapshot`; annotated screenshots with `annotations`. */
export function agentBrowserResultMintsRefs(data: unknown): boolean {
  if (Array.isArray(data)) {
    // An `exec batch` reply mints refs through any snapshot step that ran.
    return data.some(
      (step: AgentBrowserBatchEntry & { success?: boolean }) =>
        step?.success === true && agentBrowserResultMintsRefs(step.result)
    )
  }
  if (!data || typeof data !== 'object') {
    return false
  }
  return 'snapshot' in data || ('annotations' in data && Array.isArray(data.annotations))
}

/** "Unknown ref" for a ref never issued; 0.39+ says "Stale ref for role=…" or "Could not locate element with role=…" once its element is gone. */
export function isAgentBrowserStaleRefError(message: string): boolean {
  return /unknown ref|stale ref|ref not found|element not found: @e|could not locate element with role=/i.test(
    message
  )
}
