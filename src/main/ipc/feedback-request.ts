import { net } from 'electron'
import { appendFeedbackImagesToFormData } from './feedback-image-attachments'
import type {
  FeedbackImageAttachment,
  FeedbackRequestFailure
} from '../../shared/feedback-submit-contract'

// Why: the production Mac build loads the renderer from a file:// origin, so a
// cross-origin POST from fetch() triggers a CORS preflight that the feedback
// endpoint rejects. Electron's net module runs in the main process and is not
// subject to CORS, so we proxy the submission through IPC. This mirrors the
// same pattern used by updater-changelog.ts and updater-nudge.ts.
export const FEEDBACK_API_URL = 'https://www.onorca.dev/v1/feedback'
const FEEDBACK_REQUEST_TIMEOUT_MS = 10_000
const DIAGNOSTIC_BUNDLE_CONTENT_TYPE = 'application/x-ndjson'

export type FeedbackSubmissionType = 'feedback' | 'crash'

export type FeedbackDiagnosticBundleAttachment = {
  bundleSubmissionId: string
  content: string
  bytes: number
  spanCount: number
}

export type FeedbackSubmitBody = {
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

export type { FeedbackRequestFailure } from '../../shared/feedback-submit-contract'

export async function postFeedback(
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

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function responseFailure(response: Response): FeedbackRequestFailure {
  return { status: response.status, error: `status ${response.status}` }
}

export function errorFailure(error: unknown): FeedbackRequestFailure {
  return { status: null, error: messageFromError(error) }
}
