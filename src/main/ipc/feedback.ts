import os from 'node:os'
import { app, ipcMain } from 'electron'
import {
  readFeedbackImagesDelivered,
  validateFeedbackImages,
  type FeedbackImageAttachment
} from './feedback-image-attachments'
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
import type {
  FeedbackRequestFailure,
  FeedbackSubmitArgs,
  FeedbackSubmitResult
} from '../../shared/feedback-submit-contract'

export type {
  FeedbackDiagnosticBundleAttachment,
  FeedbackImageAttachment,
  FeedbackRequestFailure,
  FeedbackSubmissionType,
  FeedbackSubmitArgs,
  FeedbackSubmitResult
}

const FEEDBACK_ATTACHMENT_REQUEST_TIMEOUT_MS = 60_000
// Why: corporate filters can reject multipart with 403 and the host caps bodies
// near 4.5 MB (413) while allowing the small JSON report, so content-shaped
// failures should shed the attachment.
const ATTACHMENT_JSON_RETRY_STATUSES = new Set([400, 403, 408, 413, 415, 422])

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
    // Why: the text lane retries 5xx, this one does not. Replaying the
    // attachments on a flaky link costs more than it saves, and the dialog
    // stays open with its thumbnails while the draft text sits in the app
    // store, so a manual resend loses nothing.
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
