import os from 'node:os'
import { app, ipcMain } from 'electron'
import { readFeedbackImagesDelivered, validateFeedbackImages } from './feedback-image-attachments'
import type {
  FeedbackImageAttachment,
  FeedbackRequestFailure,
  FeedbackSubmitArgs,
  FeedbackSubmitResult
} from '../../shared/feedback-submit-contract'
import {
  errorFailure,
  FEEDBACK_API_URL,
  messageFromError,
  postFeedback,
  responseFailure,
  type FeedbackDiagnosticBundleAttachment,
  type FeedbackSubmissionType,
  type FeedbackSubmitBody
} from './feedback-request'

export type {
  FeedbackDiagnosticBundleAttachment,
  FeedbackImageAttachment,
  FeedbackRequestFailure,
  FeedbackSubmissionType,
  FeedbackSubmitArgs,
  FeedbackSubmitResult
}

const FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS = 60_000
// Content-shaped rejections may still accept small JSON after dropping attachments (corporate filters/body caps).
const ATTACHMENT_JSON_RETRY_STATUSES = new Set([400, 403, 408, 413, 415, 422])

type InternalFeedbackSubmitArgs = FeedbackSubmitArgs & {
  submissionType?: FeedbackSubmissionType
  diagnosticBundle?: FeedbackDiagnosticBundleAttachment
  feedbackWithoutDiagnosticBundle?: string
}

// Enrich trusted build/OS identity in main rather than accepting renderer claims.
function buildSubmitBody(args: InternalFeedbackSubmitArgs): FeedbackSubmitBody {
  const identity = args.submitAnonymously
    ? { githubLogin: null, githubEmail: null }
    : { githubLogin: args.githubLogin, githubEmail: args.githubEmail }

  // Allow-list anonymous payloads so stale or future identity fields cannot leak upstream.
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
    // Server accepts images only for feedback; crash reports carry diagnostic bundles.
    ...(args.submissionType !== 'crash' && args.images?.length ? { images: args.images } : {})
  }
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
    // Preserve the first failure as well as the retry outcome for support.
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
  return ATTACHMENT_JSON_RETRY_STATUSES.has(status) || status === 404 || status >= 500
}

/** Posts the attachment-free report; resolves to the failure, or null once it lands. */
async function postFeedbackWithoutAttachment(
  body: FeedbackSubmitBody
): Promise<FeedbackRequestFailure | null> {
  try {
    const response = await postFeedback(FEEDBACK_API_URL, body)
    return response.ok ? null : responseFailure(response)
  } catch (error) {
    return errorFailure(error)
  }
}

async function submitFeedbackWithoutDiagnosticBundle(
  body: FeedbackSubmitBody,
  diagnosticBundleFailure: FeedbackRequestFailure
): Promise<FeedbackSubmitResult> {
  const failure = await postFeedbackWithoutAttachment(body)
  return failure
    ? { ok: false, ...failure, diagnosticBundleFailure }
    : { ok: true, diagnosticBundleFailure }
}

async function submitFeedbackWithImages(
  body: FeedbackSubmitBody,
  bodyWithoutImages: FeedbackSubmitBody
): Promise<FeedbackSubmitResult> {
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
    const imagesFailure = responseFailure(response)
    if (ATTACHMENT_JSON_RETRY_STATUSES.has(response.status)) {
      const failure = await postFeedbackWithoutAttachment(bodyWithoutImages)
      return failure
        ? {
            ok: false,
            status: failure.status,
            error: `${imagesFailure.error}; retry: ${failure.error}`
          }
        : { ok: true, imagesDelivered: false, imagesFailure }
    }
    // Do not retry image uploads automatically; the open dialog preserves thumbnails and draft text for manual retry.
    return { ok: false, ...imagesFailure }
  } catch (error) {
    return { ok: false, ...errorFailure(error) }
  }
}

async function submitFeedbackWithDiagnosticBundle(
  body: FeedbackSubmitBody,
  bodyWithoutDiagnosticBundle: FeedbackSubmitBody | null
): Promise<FeedbackSubmitResult> {
  try {
    // Large diagnostic bundles need longer upload deadlines than small JSON reports.
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
  // Ignore discarded crash-lane images instead of rejecting over unused attachments.
  if (args.submissionType !== 'crash' && args.images !== undefined) {
    const imageError = validateFeedbackImages(args.images)
    if (imageError) {
      return { ok: false, status: null, error: imageError }
    }
  }
  const body = buildSubmitBody(args)
  if (body.images?.length) {
    return submitFeedbackWithImages(body, buildSubmitBody({ ...args, images: undefined }))
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
    // Retry the owning endpoint; api.onorca.dev serves a different product.
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
    // Validate before typed-array normalization can expand hostile renderer input.
    if (args.images !== undefined) {
      const imageError = validateFeedbackImages(args.images)
      if (imageError) {
        return { ok: false, status: null, error: imageError }
      }
    }
    // Force the public feedback lane at IPC; crash submission is main-only.
    return submitFeedback({
      ...args,
      submissionType: 'feedback'
    })
  })
}
