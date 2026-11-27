// A cloud call's result as the bot clients hand it on: a cloud error as sent, else unreachable or failed.
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../shared/connector-bot-slack-contract'
import type { ConnectorResult } from './connector-cloud-request'

export function answer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
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
