// agent-browser reads global options anywhere in argv and has no "--", so argv cannot carry
// user values. `batch` parses commands from stdin without that scan.
export const AGENT_BROWSER_BATCH_ARGS = ['batch', '--json'] as const

export function agentBrowserBatchInput(command: readonly string[]): string {
  // serde_json rejects lone surrogates; argv used to turn them into U+FFFD.
  return JSON.stringify([command.map((token) => token.toWellFormed())])
}

export type AgentBrowserEnvelope = { success?: boolean; data?: unknown; error?: string }

/** Parses --json output; a one-command batch reply becomes the single-command envelope. */
export function parseAgentBrowserJsonOutput(stdout: string): AgentBrowserEnvelope {
  const parsed = JSON.parse(stdout)
  // Orca batches one command; a longer array is a passthrough `exec batch` reply.
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return withoutDaemonLifecycle(parsed)
  }
  const [entry] = parsed
  return withoutDaemonLifecycle({
    success: entry?.success,
    data: entry?.result,
    error: entry?.error
  })
}

// agent-browser 0.31+ adds its daemon's launch bookkeeping to every reply; it is not page data.
function withoutDaemonLifecycle(envelope: AgentBrowserEnvelope): AgentBrowserEnvelope {
  const data = envelope?.data
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('lifecycle' in data)) {
    return envelope
  }
  const { lifecycle: _lifecycle, ...rest } = data
  return { ...envelope, data: rest }
}

/** Every snapshot form (plain, --full, --delta) answers with `snapshot`; annotated screenshots with `annotations`. */
export function agentBrowserResultMintsRefs(data: unknown): boolean {
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
