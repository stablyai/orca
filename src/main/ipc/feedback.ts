import os from 'node:os'
import { app, ipcMain, net } from 'electron'

// Why: the production Mac build loads the renderer from a file:// origin, so a
// cross-origin POST from fetch() triggers a CORS preflight that the feedback
// endpoint rejects. Electron's net module runs in the main process and is not
// subject to CORS, so we proxy the submission through IPC. This mirrors the
// same pattern used by updater-changelog.ts and updater-nudge.ts.
const FEEDBACK_API_URL = 'https://www.onorca.dev/v1/feedback'
const FEEDBACK_API_FALLBACK_URL = 'https://api.onorca.dev/v1/feedback'
const FEEDBACK_REQUEST_TIMEOUT_MS = 10_000
const DIAGNOSTIC_BUNDLE_CONTENT_TYPE = 'application/x-ndjson'

export type FeedbackSubmissionType = 'feedback' | 'crash'

export type FeedbackSubmitArgs = {
  feedback: string
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
}

export type FeedbackDiagnosticBundleAttachment = {
  bundleSubmissionId: string
  content: string
  bytes: number
  spanCount: number
}

type FeedbackSubmitBody = {
  feedback: string
  submissionType: FeedbackSubmissionType
  githubLogin: string | null
  githubEmail: string | null
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
}

export type FeedbackSubmitResult =
  | { ok: true }
  | { ok: false; status: number | null; error: string }

type InternalFeedbackSubmitArgs = FeedbackSubmitArgs & {
  submissionType?: FeedbackSubmissionType
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
}

// Why: the Slack notification and any follow-up investigation need to know
// which Orca build and which OS the feedback came from. The main process is
// the only place with trusted access to these values (app.getVersion and the
// node os module), so we enrich the payload here rather than trusting the
// renderer.
function buildSubmitBody(args: InternalFeedbackSubmitArgs): FeedbackSubmitBody {
  const identity = args.submitAnonymously
    ? { githubLogin: null, githubEmail: null }
    : { githubLogin: args.githubLogin, githubEmail: args.githubEmail }

  // Why: anonymity is an IPC-only privacy decision. Allow-list fields here so
  // stale renderer state or future identity-shaped fields cannot leak upstream.
  return {
    feedback: args.feedback,
    submissionType: args.submissionType ?? 'feedback',
    ...identity,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    ...(args.submissionType === 'crash' && args.diagnosticBundle
      ? { diagnosticBundle: args.diagnosticBundle }
      : {})
  }
}

async function postFeedback(url: string, body: FeedbackSubmitBody): Promise<Response> {
  const controller = new AbortController()
  // Why: a silent feedback endpoint should not leave IPC or crash-report
  // submission flows pending forever.
  const timeout = setTimeout(() => controller.abort(), FEEDBACK_REQUEST_TIMEOUT_MS)
  try {
    const init: RequestInit = {
      method: 'POST',
      ...feedbackRequestBodyInit(body),
      signal: controller.signal
    }
    return await net.fetch(url, init)
  } finally {
    clearTimeout(timeout)
  }
}

function feedbackRequestBodyInit(body: FeedbackSubmitBody): Pick<RequestInit, 'body' | 'headers'> {
  if (!body.diagnosticBundle) {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  }

  const formData = new FormData()
  appendFeedbackFormField(formData, 'feedback', body.feedback)
  appendFeedbackFormField(formData, 'submissionType', body.submissionType)
  appendFeedbackFormField(formData, 'githubLogin', body.githubLogin)
  appendFeedbackFormField(formData, 'githubEmail', body.githubEmail)
  appendFeedbackFormField(formData, 'appVersion', body.appVersion)
  appendFeedbackFormField(formData, 'platform', body.platform)
  appendFeedbackFormField(formData, 'osRelease', body.osRelease)
  appendFeedbackFormField(formData, 'arch', body.arch)
  appendFeedbackFormField(
    formData,
    'diagnosticBundleSubmissionId',
    body.diagnosticBundle.bundleSubmissionId
  )
  appendFeedbackFormField(formData, 'diagnosticBundleBytes', String(body.diagnosticBundle.bytes))
  appendFeedbackFormField(
    formData,
    'diagnosticBundleSpanCount',
    String(body.diagnosticBundle.spanCount)
  )
  formData.append(
    'diagnosticBundleFile',
    new Blob([body.diagnosticBundle.content], { type: DIAGNOSTIC_BUNDLE_CONTENT_TYPE }),
    `orca-diagnostics-${body.diagnosticBundle.bundleSubmissionId}.ndjson`
  )

  // Why: multipart avoids JSON-escaping a near-cap NDJSON bundle over the
  // backend request limit while still submitting one feedback request.
  return { body: formData }
}

function appendFeedbackFormField(formData: FormData, key: string, value: string | null): void {
  if (value !== null) {
    formData.append(key, value)
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function submitFallbackFeedback(
  body: FeedbackSubmitBody,
  primaryError?: unknown
): Promise<FeedbackSubmitResult> {
  try {
    const fallback = await postFeedback(FEEDBACK_API_FALLBACK_URL, body)
    if (fallback.ok) {
      return { ok: true }
    }
    return { ok: false, status: fallback.status, error: `status ${fallback.status}` }
  } catch (fallbackError) {
    const message = messageFromError(fallbackError)
    if (primaryError === undefined) {
      return { ok: false, status: null, error: message }
    }
    return {
      ok: false,
      status: null,
      error: `${messageFromError(primaryError)}; fallback: ${message}`
    }
  }
}

export async function submitFeedback(
  args: InternalFeedbackSubmitArgs
): Promise<FeedbackSubmitResult> {
  const body = buildSubmitBody(args)
  try {
    const res = await postFeedback(FEEDBACK_API_URL, body)
    if (res.ok) {
      return { ok: true }
    }
    // Why: keep api.onorca.dev as a compatibility fallback, but prefer the
    // website API because it owns the Slack file/snippet crash delivery path.
    if (res.status === 404 || res.status >= 500) {
      return submitFallbackFeedback(body)
    }
    return { ok: false, status: res.status, error: `status ${res.status}` }
  } catch (error) {
    // Why: falling back on any network-level failure preserves the prior
    // behavior where DNS/connect failures on the primary host transparently
    // try the legacy API endpoint.
    return submitFallbackFeedback(body, error)
  }
}

export function registerFeedbackHandlers(): void {
  ipcMain.removeHandler('feedback:submit')
  ipcMain.handle('feedback:submit', (_event, args: FeedbackSubmitArgs) =>
    // Why: crash submissions are main-only. A compromised renderer can invoke
    // this channel directly, so force the public feedback lane at the boundary.
    submitFeedback({ ...args, submissionType: 'feedback' })
  )
}
