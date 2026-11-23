import type { AcpTurnEnding } from './acp-dialect'

// agy's line for a Google API error it couldn't run a turn past, e.g. "<warning sign> agent executor error:
// generating and executing: Error 400, Message: API key not valid. ..., Status: INVALID_ARGUMENT,
// Details: [map[...]]". The message is Google's own sentence; the status and details are for support.
// The bundle must stay ASCII, so the warning sign is escaped.
const MAX_PARSED_LENGTH = 16_384
// Google names a refused key in its ErrorInfo reason (API_KEY_INVALID, API_KEY_EXPIRED, ...).
const KEY_REASON = /\breason:API_KEY_[A-Z_]+/
const EXECUTOR_API_ERROR =
  /^(\u26a0 agent executor error: [^\n]*?Error (\d{3}), Message: ([^\n]*?)), Status: ([A-Z_]+)(?:, Details: ([^\n]*))?$/

/** agy's executor-error line for a Google API error as Google's sentence first, then the whole
 *  line, broken at its Status and Details, under Details. Other notices keep their own words. */
export function antigravityExecutorErrorWords(
  notice: string
): Pick<AcpTurnEnding, 'failureDetail' | 'failureFrame'> | undefined {
  // The lazy groups backtrack on a long line; agy's own lines are far shorter, and a longer one
  // keeps its raw words.
  if (notice.length > MAX_PARSED_LENGTH) {
    return undefined
  }
  const match = EXECUTOR_API_ERROR.exec(notice)
  if (!match) {
    return undefined
  }
  const [, lead, code, rawMessage, status, details] = match
  const message = rawMessage.trim()
  const keyRejected = details !== undefined && KEY_REASON.test(details)
  const failureDetail = !message
    ? `Google returned error ${code} (${status}).`
    : keyRejected
      ? `Google rejected the API key: ${message}`
      : `Google returned an error: ${message}`
  return {
    failureDetail,
    failureFrame: [
      lead,
      `Status: ${status}`,
      ...(details === undefined ? [] : [`Details: ${details}`])
    ].join('\n')
  }
}
