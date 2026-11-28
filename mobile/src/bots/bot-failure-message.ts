import { translate } from '../i18n/mobile-i18n'
import { RpcRefusedError } from '../transport/rpc/rpc-refused-error'
import { botFailureText, readBotFailure } from '../../../src/shared/bots/bot-failure-copy'

/** A bot failure the host sent by code, in the phone's language; null when it sent none. */
export function botFailureMessage(error: unknown): string | null {
  const data = error instanceof RpcRefusedError ? error.data : undefined
  const failure = readBotFailure(
    typeof data === 'object' && data !== null && 'botFailure' in data ? data.botFailure : undefined
  )
  return failure ? botFailureText(failure, translate) : null
}
