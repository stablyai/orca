import { net } from 'electron'
import { appendFeedbackImagesToFormData } from './feedback-image-attachments'
import type {
  FeedbackImageAttachment,
  FeedbackRequestFailure
} from '../../shared/feedback-submit-contract'

// Main-process HTTP avoids CORS preflights rejected by feedback when packaged renderers use file origins.
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

export async function postFeedback(
  url: string,
  body: FeedbackSubmitBody,
  timeoutMs = FEEDBACK_REQUEST_TIMEOUT_MS,
  readResponse?: (response: Response) => Promise<void>
): Promise<Response> {
  const controller = new AbortController()
  // Bound IPC even when the endpoint stays silent.
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
    // Tolerant legacy parsing must not turn an aborted body into confirmed delivery.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs / 1000} seconds`)
    }
    return response
  } catch (error) {
    // Normalize differing Electron/Node AbortError shapes for stable deadline logs.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs / 1000} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
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

  // Multipart avoids JSON escaping that can push near-cap NDJSON bundles over the backend limit.
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
