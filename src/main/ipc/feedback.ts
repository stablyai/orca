import os from 'node:os'
import { app, ipcMain, net } from 'electron'

// Why: the production Mac build loads the renderer from a file:// origin, so a
// cross-origin POST from fetch() triggers a CORS preflight that the feedback
// endpoint rejects. Electron's net module runs in the main process and is not
// subject to CORS, so we proxy the submission through IPC. This mirrors the
// same pattern used by updater-changelog.ts and updater-nudge.ts.
const FEEDBACK_API_URL = 'https://api.onorca.dev/v1/feedback'
const FEEDBACK_API_FALLBACK_URL = 'https://www.onorca.dev/v1/feedback'

export type FeedbackSubmitArgs = {
  feedback: string
  githubLogin: string | null
  githubEmail: string | null
}

type FeedbackSubmitBody = FeedbackSubmitArgs & {
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
}

export type FeedbackSubmitResult =
  | { ok: true }
  | { ok: false; status: number | null; error: string }

// Why: the Slack notification and any follow-up investigation need to know
// which Orca build and which OS the feedback came from. The main process is
// the only place with trusted access to these values (app.getVersion and the
// node os module), so we enrich the payload here rather than trusting the
// renderer.
function buildSubmitBody(args: FeedbackSubmitArgs): FeedbackSubmitBody {
  return {
    ...args,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch
  }
}

async function postFeedback(url: string, body: FeedbackSubmitBody): Promise<Response> {
  return net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

export async function submitFeedback(args: FeedbackSubmitArgs): Promise<FeedbackSubmitResult> {
  const body = buildSubmitBody(args)
  try {
    const res = await postFeedback(FEEDBACK_API_URL, body)
    if (res.ok) {
      return { ok: true }
    }
    // Why: DNS for api.onorca.dev can lag behind a deploy. Only fall back on
    // 404/5xx-style results and network errors — don't mask real 4xx responses
    // from a healthy host.
    if (res.status === 404 || res.status >= 500) {
      const fallback = await postFeedback(FEEDBACK_API_FALLBACK_URL, body)
      if (fallback.ok) {
        return { ok: true }
      }
      return { ok: false, status: fallback.status, error: `status ${fallback.status}` }
    }
    return { ok: false, status: res.status, error: `status ${res.status}` }
  } catch (error) {
    // Why: falling back on any network-level failure preserves the prior
    // behavior where DNS/connect failures on the primary host transparently
    // try the website-hosted versioned endpoint.
    try {
      const fallback = await postFeedback(FEEDBACK_API_FALLBACK_URL, body)
      if (fallback.ok) {
        return { ok: true }
      }
      return { ok: false, status: fallback.status, error: `status ${fallback.status}` }
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      const primaryMessage = error instanceof Error ? error.message : String(error)
      return { ok: false, status: null, error: `${primaryMessage}; fallback: ${message}` }
    }
  }
}

export function registerFeedbackHandlers(): void {
  ipcMain.removeHandler('feedback:submit')
  ipcMain.handle('feedback:submit', (_event, args: FeedbackSubmitArgs) => submitFeedback(args))
}
