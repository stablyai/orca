/**
 * `office.watchRefresh` — force a running watch server to re-render.
 *
 * `officecli watch` does not detect external edits, and an agent editing the document is exactly
 * the external-edit case, so refresh is pushed rather than awaited. Re-POSTing the same path to
 * the server's `/api/switch` is the tool's documented force-re-render, and it tells connected
 * pages to reload themselves.
 *
 * Reloading the webview instead would not work: `GET /` serves the server's cached render, so a
 * reload can return the same stale document and the control appears to be a lie.
 */
import { request } from 'node:http'
import {
  OFFICE_WATCH_SWITCH_TIMEOUT_MS,
  officeFailure,
  type OfficeAckOutcome
} from '../../shared/office-preview-contracts'
import { canonicalOfficeDocumentPath } from './office-document-path'
import { classifyOfficeThrown, classifySwitchStatus } from './office-error-codes'
import { findOfficeWatchSession } from './office-watch-manager'
import { officecliSwitchRequest } from './officecli-argv'
import { NATIVE_OFFICECLI_LANE, type OfficecliLane } from './officecli-lane'

type SwitchResponse = { status: number; body: string }

function postSwitch(port: number, documentPath: string): Promise<SwitchResponse> {
  const { url, body } = officecliSwitchRequest(port, documentPath)
  return new Promise((settle, reject) => {
    const call = request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        // A render budget, not a network one: a media-heavy deck legitimately takes a while.
        timeout: OFFICE_WATCH_SWITCH_TIMEOUT_MS
      },
      (response) => {
        let received = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          received += received.length < 4_000 ? chunk : ''
        })
        response.on('end', () => settle({ status: response.statusCode ?? 0, body: received }))
      }
    )
    call.once('timeout', () => call.destroy(new Error('The watch server did not answer in time')))
    call.once('error', reject)
    call.end(body)
  })
}

function switchDetail(body: string): string | undefined {
  const match = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
  return match?.[1] ?? (body.trim() ? body.trim().slice(0, 400) : undefined)
}

export async function refreshOfficeWatch(
  documentPath: string,
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeAckOutcome> {
  try {
    const canonicalPath = await canonicalOfficeDocumentPath(documentPath, lane)
    const session = findOfficeWatchSession(lane, canonicalPath)
    if (!session) {
      // Not a failure to hide: the caller's live preview is gone or was never started, and saying
      // so is what lets the surface fall back to a snapshot instead of spinning.
      return officeFailure('OFFICE_WATCH_NOT_RUNNING')
    }
    const response = await postSwitch(session.port, session.documentPath)
    // Every documented rejection is safe to report as "the refresh did not happen": the server
    // keeps serving the document it already had when a switch fails.
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : classifySwitchStatus(response.status, switchDetail(response.body))
  } catch (error) {
    return classifyOfficeThrown(error, 'watch')
  }
}
