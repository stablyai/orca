// What Composio's answers can mean to Orca, each as its own error so callers can tell them apart.
import { z } from 'zod'

/** Composio refused the key: deleted, regenerated, or not a project key. */
export class ComposioKeyRejectedError extends Error {
  constructor() {
    super('Composio didn’t accept this key. Copy a project API key from Composio and try again.')
  }
}

/** The app signs in only through a developer app the owner adds in Composio's Auth Configs. */
export class ComposioNeedsOwnSignInError extends Error {
  constructor(readonly app: string) {
    super(
      'This app needs a one-time setup in Composio: your own developer app, added under Auth Configs.'
    )
  }
}

export class ComposioUnavailableError extends Error {}

export class ComposioNotFoundError extends ComposioUnavailableError {}

/**
 * Composio is limiting this project: too many calls for now (`retryAt`), or the plan's monthly
 * cap, which lifts only with a new month or plan (`retryAt` null).
 */
export class ComposioLimitError extends ComposioUnavailableError {
  constructor(
    readonly retryAt: number | null,
    readonly detail: string | undefined
  ) {
    super(
      retryAt === null
        ? `Composio's plan limit is reached${detail ? `: ${detail}` : ''}. Calls resume with a new month or plan.`
        : 'Composio is limiting calls for a moment. Try again shortly.'
    )
  }
}

// Longest Retry-After Orca waits out in place before calling once more.
export const COMPOSIO_RETRY_WAIT_MAX_MS = 10_000

/** Milliseconds from a Retry-After header (seconds or an HTTP date), or null. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }
  const date = Date.parse(header)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

/** The plan's cap rather than a burst: a 429 only when its words name the month or quota. */
export function isComposioPlanLimit(status: number, slug?: string, message?: string): boolean {
  return status !== 429 || /month|quota/i.test(`${slug ?? ''} ${message ?? ''}`)
}

/** A 429 or 402, or an answer whose slug or words name a rate, usage or plan limit. */
export function isComposioLimit(status: number, slug?: string, message?: string): boolean {
  return (
    status === 429 ||
    status === 402 ||
    /quota|usage.?limit|plan.?limit|limit.?(exceeded|reached)|rate.?limit/i.test(
      `${slug ?? ''} ${message ?? ''}`
    )
  )
}

const ErrorBody = z.object({
  error: z.object({ message: z.string().optional(), slug: z.string().optional() })
})

export const composioErrorOf = (json: unknown) => ErrorBody.safeParse(json).data?.error

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
