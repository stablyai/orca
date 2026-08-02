import os from 'node:os'
import { app, ipcMain, net } from 'electron'
import {
  appendFeedbackImagesToFormData,
  readFeedbackImagesDelivered,
  validateFeedbackImages,
  type FeedbackImageAttachment
} from './feedback-image-attachments'

export type { FeedbackImageAttachment }

// Why: the production Mac build loads the renderer from a file:// origin, so a
// cross-origin POST from fetch() triggers a CORS preflight that the feedback
// endpoint rejects. Electron's net module runs in the main process and is not
// subject to CORS, so we proxy the submission through IPC. This mirrors the
// same pattern used by updater-changelog.ts and updater-nudge.ts.
const FEEDBACK_API_URL = 'https://www.onorca.dev/v1/feedback'
const FEEDBACK_REQUEST_TIMEOUT_MS = 10_000
const FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS = 60_000
const DIAGNOSTIC_BUNDLE_CONTENT_TYPE = 'application/x-ndjson'
// Why: corporate filters can reject multipart with 403 while allowing the
// small JSON report, so content-shaped failures should shed the attachment.
const DIAGNOSTIC_BUNDLE_JSON_RETRY_STATUSES = new Set([400, 403, 408, 413, 415, 422])

export type FeedbackSubmissionType = 'feedback' | 'crash'

export type FeedbackSubmitArgs = {
  feedback: string
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
  images?: FeedbackImageAttachment[]
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
  images?: FeedbackImageAttachment[]
}

export type FeedbackRequestFailure = {
  status: number | null
  error: string
}

export type FeedbackSubmitResult =
  | {
      ok: true
      diagnosticBundleFailure?: FeedbackRequestFailure
      /** Absent when nothing was attached; false when the text landed but the images did not. */
      imagesDelivered?: boolean
    }
  | ({ ok: false } & FeedbackRequestFailure & {
        diagnosticBundleFailure?: FeedbackRequestFailure
      })

type InternalFeedbackSubmitArgs = FeedbackSubmitArgs & {
  submissionType?: FeedbackSubmissionType
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
  feedbackWithoutDiagnosticBundle?: string
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
      : {}),
    // Why: images are a feedback-only affordance; crash reports already carry
    // diagnostic bundles and the server rejects images on that lane.
    ...(args.submissionType !== 'crash' && args.images?.length ? { images: args.images } : {})
  }
}

async function postFeedback(
  url: string,
  body: FeedbackSubmitBody,
  timeoutMs = FEEDBACK_REQUEST_TIMEOUT_MS,
  readResponse?: (response: Response) => Promise<void>
): Promise<Response> {
  const controller = new AbortController()
  // Why: a silent endpoint must not leave feedback IPC pending forever.
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const init: RequestInit = {
      method: 'POST',
      ...feedbackRequestBodyInit(body),
      signal: controller.signal
    }
    const response = await net.fetch(url, init)
    if (readResponse) {
      await readResponse(response)
    }
    // Why: a response parser may tolerate malformed legacy bodies, but it must
    // not turn the deadline's aborted body into a confirmed delivery.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs / 1000} seconds`)
    }
    return response
  } catch (error) {
    // Why: Electron and Node report AbortError differently; keep deadline logs stable.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs / 1000} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function feedbackRequestBodyInit(body: FeedbackSubmitBody): Pick<RequestInit, 'body' | 'headers'> {
  if (!body.diagnosticBundle && !body.images?.length) {
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
  if (body.diagnosticBundle) {
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
  }
  appendFeedbackImagesToFormData(formData, body.images ?? [])

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

function responseFailure(response: Response): FeedbackRequestFailure {
  return { status: response.status, error: `status ${response.status}` }
}

function errorFailure(error: unknown): FeedbackRequestFailure {
  return { status: null, error: messageFromError(error) }
}

async function retryFeedbackOnPrimary(
  body: FeedbackSubmitBody,
  primaryError?: unknown
): Promise<FeedbackSubmitResult> {
  try {
    const retry = await postFeedback(FEEDBACK_API_URL, body)
    if (retry.ok) {
      return { ok: true }
    }
    const retryMessage = `status ${retry.status}`
    if (primaryError === undefined) {
      return { ok: false, status: retry.status, error: retryMessage }
    }
    // Why: keep the first failure visible so support can see 5xx → retry outcome,
    // not only the last error in a same-host retry chain.
    return {
      ok: false,
      status: retry.status,
      error: `${messageFromError(primaryError)}; retry: ${retryMessage}`
    }
  } catch (retryError) {
    const message = messageFromError(retryError)
    if (primaryError === undefined) {
      return { ok: false, status: null, error: message }
    }
    return {
      ok: false,
      status: null,
      error: `${messageFromError(primaryError)}; retry: ${message}`
    }
  }
}

function shouldRetryWithoutDiagnosticBundle(status: number): boolean {
  return DIAGNOSTIC_BUNDLE_JSON_RETRY_STATUSES.has(status) || status === 404 || status >= 500
}

async function submitFeedbackWithoutDiagnosticBundle(
  body: FeedbackSubmitBody,
  diagnosticBundleFailure: FeedbackRequestFailure
): Promise<FeedbackSubmitResult> {
  try {
    const response = await postFeedback(FEEDBACK_API_URL, body)
    if (response.ok) {
      return { ok: true, diagnosticBundleFailure }
    }
    return { ok: false, ...responseFailure(response), diagnosticBundleFailure }
  } catch (error) {
    return { ok: false, ...errorFailure(error), diagnosticBundleFailure }
  }
}

async function submitFeedbackWithDiagnosticBundle(
  body: FeedbackSubmitBody,
  bodyWithoutDiagnosticBundle: FeedbackSubmitBody | null
): Promise<FeedbackSubmitResult> {
  try {
    // Why: diagnostic bundles can approach 4 MiB and need more upload time than
    // the small JSON report-only path, especially on constrained connections.
    const response = await postFeedback(
      FEEDBACK_API_URL,
      body,
      FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS
    )
    if (response.ok) {
      return { ok: true }
    }
    const failure = responseFailure(response)
    if (bodyWithoutDiagnosticBundle && shouldRetryWithoutDiagnosticBundle(response.status)) {
      return submitFeedbackWithoutDiagnosticBundle(bodyWithoutDiagnosticBundle, failure)
    }
    return { ok: false, ...failure }
  } catch (error) {
    const failure = errorFailure(error)
    return bodyWithoutDiagnosticBundle
      ? submitFeedbackWithoutDiagnosticBundle(bodyWithoutDiagnosticBundle, failure)
      : { ok: false, ...failure }
  }
}

export async function submitFeedback(
  args: InternalFeedbackSubmitArgs
): Promise<FeedbackSubmitResult> {
  // Why: buildSubmitBody drops images on the crash lane, so validating them
  // there would abort a crash report over attachments it never meant to send.
  if (args.submissionType !== 'crash' && args.images !== undefined) {
    const imageError = validateFeedbackImages(args.images)
    if (imageError) {
      return { ok: false, status: null, error: imageError }
    }
  }
  const body = buildSubmitBody(args)
  if (body.images?.length) {
    try {
      let imagesDelivered = true
      const response = await postFeedback(
        FEEDBACK_API_URL,
        body,
        FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS,
        async (nextResponse) => {
          imagesDelivered = nextResponse.ok ? await readFeedbackImagesDelivered(nextResponse) : true
        }
      )
      if (response.ok) {
        return { ok: true, imagesDelivered }
      }
      // Why: the text lane retries 5xx, this one does not. Replaying up to
      // 32 MiB of attachments on a flaky link costs more than it saves, and the
      // dialog keeps the draft and thumbnails so the user can resend.
      return { ok: false, ...responseFailure(response) }
    } catch (error) {
      return { ok: false, ...errorFailure(error) }
    }
  }
  if (body.diagnosticBundle) {
    const bodyWithoutDiagnosticBundle =
      args.feedbackWithoutDiagnosticBundle !== undefined
        ? buildSubmitBody({
            ...args,
            feedback: args.feedbackWithoutDiagnosticBundle,
            diagnosticBundle: undefined
          })
        : null
    return submitFeedbackWithDiagnosticBundle(body, bodyWithoutDiagnosticBundle)
  }
  try {
    const res = await postFeedback(FEEDBACK_API_URL, body)
    if (res.ok) {
      return { ok: true }
    }
    // Why: api.onorca.dev serves a different product, so transient failures
    // retry the endpoint that owns feedback and crash delivery.
    if (res.status >= 500) {
      return retryFeedbackOnPrimary(body, new Error(`status ${res.status}`))
    }
    return { ok: false, status: res.status, error: `status ${res.status}` }
  } catch (error) {
    return retryFeedbackOnPrimary(body, error)
  }
}

export function registerFeedbackHandlers(): void {
  ipcMain.removeHandler('feedback:submit')
  ipcMain.handle('feedback:submit', (_event, args: FeedbackSubmitArgs) => {
    // Why: validate the raw clone before normalization so a tiny hostile value
    // cannot become a large main-process typed-array allocation.
    if (args.images !== undefined) {
      const imageError = validateFeedbackImages(args.images)
      if (imageError) {
        return { ok: false, status: null, error: imageError }
      }
    }
    // Why: crash submissions are main-only. A compromised renderer can invoke
    // this channel directly, so force the public feedback lane at the boundary.
    return submitFeedback({
      ...args,
      submissionType: 'feedback'
    })
  })
}
