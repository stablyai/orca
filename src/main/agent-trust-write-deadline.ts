import type { AgentTrustPreset } from './agent-trust-presets'

/**
 * Why: callers hold launch admission on a trust write, but the write is not
 * self-bounding. The local Codex writer queues on the per-`config.toml` lane
 * shared with hook installs and app-server trust grants (up to 10s native /
 * 30s WSL each, with no cap on how many are already queued). Without a cap the
 * user clicks "start agent" and nothing happens, with no error.
 *
 * 20s covers a native grant session holding the lane with headroom. Past that
 * we stop waiting and let the launch proceed *untrusted*: the write is never
 * cancelled and still lands, and the agent meanwhile raises its own "Do you
 * trust this folder?" prompt. Giving up therefore fails closed — it can only
 * lose the ordering optimisation, never grant trust that was not written.
 */
export const AGENT_TRUST_WRITE_DEADLINE_MS = 20_000

/** Writers with no shared lock lane, local or on the relay: a stall past this means the agent asks. */
export const SHORT_AGENT_TRUST_WRITE_DEADLINE_MS = 1_500

/**
 * Awaits a trust write but never longer than the deadline. Rejections
 * propagate to the caller's best-effort catch; a deadline miss is reported as
 * a named warning rather than an exception, because every caller treats a
 * failed trust write as "let the agent ask the user".
 */
export async function awaitAgentTrustWriteWithinDeadline(
  write: Promise<void>,
  context: { preset: AgentTrustPreset; workspacePath: string; deadlineMs?: number }
): Promise<void> {
  const deadlineMs = context.deadlineMs ?? AGENT_TRUST_WRITE_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), deadlineMs)
  })
  try {
    // Why race adopts `write`: it attaches handlers, so a rejection arriving
    // after the deadline is consumed here instead of surfacing unhandled.
    const outcome = await Promise.race([write.then(() => 'written' as const), expiry])
    if (outcome === 'expired') {
      console.warn(
        `[agent-trust] ${context.preset} trust write for ${context.workspacePath} did not settle within ${deadlineMs}ms; continuing untrusted so the agent can prompt`
      )
    }
  } finally {
    clearTimeout(timer)
  }
}
