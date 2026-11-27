import { ARTIFACT_RATE_LIMITED_CODE } from '../../shared/artifacts/artifacts'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'

const MAX_SERVER_MESSAGE_LENGTH = 300

export type ArtifactRateLimitDetails = {
  retryAfterSeconds: number | null
  resetAt: string | null
  scope: 'account' | 'network' | null
  limit: number | null
  windowSeconds: number | null
}

/** A 429 from the artifact API; `message` is written for people, `data` for programs. */
export class ArtifactCloudRateLimitError extends OrcaCloudRequestError {
  readonly code = ARTIFACT_RATE_LIMITED_CODE
  readonly data: ArtifactRateLimitDetails

  constructor(message: string, data: ArtifactRateLimitDetails, errorCode?: string) {
    super(429, errorCode)
    this.name = 'ArtifactCloudRateLimitError'
    this.message = message
    this.data = data
  }
}

/** Retry-After is delay-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterSeconds(header: string | null, now = Date.now()): number | null {
  const value = header?.trim()
  if (!value) {
    return null
  }
  if (/^\d+$/.test(value)) {
    return Number(value)
  }
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// Server text reaches a terminal; drop control characters so it cannot rewrite the screen.
function sanitizeServerMessage(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value
    // oxlint-disable-next-line no-control-regex -- matching control bytes is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) {
    return null
  }
  return text.length > MAX_SERVER_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_SERVER_MESSAGE_LENGTH - 1)}…`
    : text
}

function formatLocalResetTime(resetAt: Date, now: Date): string {
  const sameDay = resetAt.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  }).format(resetAt)
}

function formatWait(seconds: number): string {
  if (seconds < 60) {
    return seconds === 1 ? '1 second' : `${seconds} seconds`
  }
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) {
    return minutes === 1 ? '1 minute' : `${minutes} minutes`
  }
  const hours = Math.ceil(minutes / 60)
  return hours === 1 ? '1 hour' : `${hours} hours`
}

function withSentenceEnd(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`
}

export type ArtifactRateLimitResponse = {
  error: ArtifactCloudRateLimitError
  /** Seconds the server asked us to wait; null when it gave no usable hint. */
  retryAfterSeconds: number | null
}

/** Reads both the structured 429 body and the bare 429 older servers send. */
export async function readArtifactRateLimitResponse(
  response: Response,
  now = new Date()
): Promise<ArtifactRateLimitResponse> {
  const raw: unknown = await response.json().catch(() => null)
  const body = isRecord(raw) ? raw : {}
  const bodyRetryAfter = nonNegativeNumber(body.retryAfterSeconds)
  const retryAfterSeconds =
    parseRetryAfterSeconds(response.headers.get('retry-after'), now.getTime()) ??
    (bodyRetryAfter === null ? null : Math.ceil(bodyRetryAfter))
  const resetDate = typeof body.resetAt === 'string' ? new Date(body.resetAt) : null
  const resetAt = resetDate && !Number.isNaN(resetDate.getTime()) ? resetDate : null
  const serverMessage = sanitizeServerMessage(body.message)
  const when = resetAt
    ? `Try again after ${formatLocalResetTime(resetAt, now)}.`
    : retryAfterSeconds !== null
      ? `Try again in ${formatWait(retryAfterSeconds)}.`
      : 'Try again later.'
  const summary = withSentenceEnd(serverMessage ?? 'Artifact sharing is rate limited')
  // Servers that send resetAt already name the retry time in the message.
  const message = serverMessage && resetAt ? summary : `${summary} ${when}`
  const scope = body.scope === 'account' || body.scope === 'network' ? body.scope : null
  const error = new ArtifactCloudRateLimitError(
    message,
    {
      retryAfterSeconds,
      resetAt: resetAt?.toISOString() ?? null,
      scope,
      limit: nonNegativeNumber(body.limit),
      windowSeconds: nonNegativeNumber(body.windowSeconds)
    },
    typeof body.code === 'string' ? body.code : undefined
  )
  return { error, retryAfterSeconds }
}
