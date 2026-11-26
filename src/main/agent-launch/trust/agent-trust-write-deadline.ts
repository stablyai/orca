import type { AgentTrustPreset } from './agent-trust-presets'

/** Bound waits behind Codex hook-install locks; timeout permits launch while the trust write continues. */
export const AGENT_TRUST_WRITE_DEADLINE_MS = 20_000

/** Writers without shared lock queues need less grace; timeout leaves the agent to ask. */
export const SHORT_AGENT_TRUST_WRITE_DEADLINE_MS = 1_500

/** Return a fallback when a best-effort lookup does not settle before launch must continue. */
export async function awaitValueWithinDeadline<T>(
  value: Promise<T>,
  deadlineMs: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs)
  })
  try {
    return await Promise.race([value, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/** Propagate write failures; warn on deadline without canceling the write. */
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
    // Promise.race consumes late write rejections after the deadline.
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
