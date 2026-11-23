// One bounded, harmless read per Google API, so status can say which services work and what to do
// about the rest: grant the permission, turn the API on in the project, or ask the company admin.
import { z } from 'zod'
import type {
  GoogleServiceReadiness,
  GoogleServiceState
} from '../../shared/google/google-connect-types'
import {
  GOOGLE_SERVICE_INFO,
  googleApiEnableUrl,
  googleChoiceServices,
  googleServiceGranted,
  type GoogleService,
  type GoogleServiceChoice
} from '../../shared/google/google-scopes'
import type { GoogleHttp } from './google-token-endpoint'

const PROBE_TIMEOUT_MS = 10_000
const MAX_DETAIL_CHARS = 200
// Docs and Sheets have no list call within their scopes; a made-up id answers 404 once the API is on.
const ABSENT_ID = 'orca-readiness-check'

const PROBES: Record<GoogleService, { url: string; absentIsReady?: true }> = {
  gmail: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' },
  calendar: { url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1' },
  drive: { url: 'https://www.googleapis.com/drive/v3/about?fields=user' },
  docs: { url: `https://docs.googleapis.com/v1/documents/${ABSENT_ID}`, absentIsReady: true },
  sheets: {
    url: `https://sheets.googleapis.com/v4/spreadsheets/${ABSENT_ID}`,
    absentIsReady: true
  },
  contacts: {
    url: 'https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names'
  }
}

const ADMIN_BLOCK =
  /admin|domain policy|not enabled for (this|the) (user|domain)|mail service not enabled/i

export type GoogleApiError = {
  status: number
  message: string
  reasons: string[]
  activationUrl?: string
}

// Google's error body: `details` (ErrorInfo, newer APIs) and `errors` (older ones) both carry a reason.
const ErrorEntry = z.object({
  reason: z.string().optional().catch(undefined),
  metadata: z.object({ activationUrl: z.string().optional() }).optional().catch(undefined)
})
const ErrorEntries = z
  .array(z.unknown())
  .transform((entries) => entries.flatMap((entry) => ErrorEntry.safeParse(entry).data ?? []))
const ApiErrorBody = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    details: ErrorEntries.optional().catch(undefined),
    errors: ErrorEntries.optional().catch(undefined)
  })
})
const CONSOLE_URL = /^https:\/\/console\.(developers|cloud)\.google\.com\//

export function readGoogleApiError(status: number, body: unknown): GoogleApiError {
  const error = ApiErrorBody.safeParse(body).data?.error
  const entries = [...(error?.details ?? []), ...(error?.errors ?? [])]
  const reasons = [
    ...entries.flatMap((entry) => (entry.reason ? [entry.reason] : [])),
    ...(error?.status ? [error.status] : [])
  ]
  const activationUrl = entries
    .map((entry) => entry.metadata?.activationUrl)
    .find((url) => url !== undefined && CONSOLE_URL.test(url))
  return {
    status,
    message: error?.message?.slice(0, MAX_DETAIL_CHARS) ?? `HTTP ${status}`,
    reasons,
    ...(activationUrl ? { activationUrl } : {})
  }
}

/** What a refused probe means; exported for tests that pin Google's error shapes. */
export function classifyGoogleApiError(
  service: GoogleService,
  error: GoogleApiError,
  projectId?: string
): GoogleServiceReadiness {
  const has = (...names: string[]) => error.reasons.some((reason) => names.includes(reason))
  const result = (state: GoogleServiceState, extra: Partial<GoogleServiceReadiness> = {}) => ({
    service,
    state,
    ...extra
  })
  if (has('SERVICE_DISABLED', 'accessNotConfigured')) {
    return result('api-disabled', {
      detail: `The ${GOOGLE_SERVICE_INFO[service].label} API is turned off in your Google project.`,
      enableUrl: error.activationUrl ?? googleApiEnableUrl(service, projectId)
    })
  }
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')) {
    return result('needs-permission')
  }
  if ((error.status === 403 || error.status === 400) && ADMIN_BLOCK.test(error.message)) {
    return result('blocked-by-admin', { detail: error.message })
  }
  return result('error', { detail: error.message })
}

async function probe(
  http: GoogleHttp,
  service: GoogleService,
  accessToken: string,
  projectId?: string
): Promise<GoogleServiceReadiness> {
  const { url, absentIsReady } = PROBES[service]
  let response: Response
  try {
    response = await http(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return { service, state: 'error', detail: "Couldn't reach Google." }
  }
  if (response.ok || (absentIsReady && (response.status === 404 || response.status === 400))) {
    return { service, state: 'ready' }
  }
  const body: unknown = await response.json().catch(() => null)
  return classifyGoogleApiError(service, readGoogleApiError(response.status, body), projectId)
}

/** The picked services' states: an ungranted scope is known without a call; the rest read once each, together. */
export async function checkGoogleServices(args: {
  http: GoogleHttp
  accessToken: string
  grantedScopes: readonly string[]
  choices: readonly GoogleServiceChoice[]
  projectId?: string
}): Promise<GoogleServiceReadiness[]> {
  const granted = new Set(args.grantedScopes)
  return Promise.all(
    googleChoiceServices(args.choices).map((service) =>
      googleServiceGranted(service, granted)
        ? probe(args.http, service, args.accessToken, args.projectId)
        : Promise.resolve<GoogleServiceReadiness>({ service, state: 'needs-permission' })
    )
  )
}
