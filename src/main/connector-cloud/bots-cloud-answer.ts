// A connector call's result as a bot setup surface reads it: the cloud's code, or why there is none.
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../shared/connector-bot-slack-contract'
import type { ConnectorResult } from './connector-cloud-request'

export function botsCloudAnswer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  if (result.ok) {
    return result
  }
  const error =
    result.error ??
    (result.status === null
      ? BOT_SLACK_DESKTOP_ERRORS.unreachable
      : BOT_SLACK_DESKTOP_ERRORS.failed)
  return { ok: false, error }
}

/** A bare 404 is a cloud without that source's routes; a 404 with a code is that code. */
export const offAnswer =
  (off: string) =>
  <T>(result: ConnectorResult<T>): BotSlackResult<T> =>
    !result.ok && result.status === 404 && result.error === null
      ? { ok: false, error: off }
      : botsCloudAnswer(result)
