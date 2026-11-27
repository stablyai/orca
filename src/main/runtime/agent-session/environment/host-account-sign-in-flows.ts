import { stripAnsiEscapeSequences } from '../../../../shared/terminal/protocol/escape/ansi-escape-sequences'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../shared/agent-accounts/codex/codex-auth-errors'
import {
  HOST_ACCOUNT_SIGN_IN_FAILURE_COPY,
  isHostAccountSignInPage,
  type HostAccountSignInChannel,
  type HostAccountSignInPrompt,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../../../shared/agent-accounts/host-account-sign-in-types'
import { CallerOwnedSignInFlows } from '../../caller-owned-sign-in-flows'

const MAX_ERROR_CHARS = 600
const LOGIN_CANCELLED_MESSAGES = new Set([
  'Claude sign-in was cancelled.',
  CODEX_LOGIN_CANCELLED_MESSAGE
])

type HostAccountSignInResult = Pick<HostAccountSignInStatus, 'claude' | 'codex'>

export type HostAccountSignInRunner = (
  provider: HostAccountSignInProvider,
  channel: HostAccountSignInChannel,
  accountId: string | undefined
) => Promise<HostAccountSignInResult>

/** Claude/Codex logins run on this host for a client elsewhere (#20009); an account id signs that
 *  saved account in again instead of adding one. */
export class HostAccountSignInFlows extends CallerOwnedSignInFlows<
  HostAccountSignInProvider,
  HostAccountSignInPrompt,
  string,
  HostAccountSignInResult,
  string
> {
  constructor(run: HostAccountSignInRunner, platform: NodeJS.Platform = process.platform) {
    super(run, {
      refuseStart: (accountId) =>
        platform !== 'win32'
          ? null
          : accountId
            ? 'Signing in again from another device is not available on Windows hosts yet. Sign in again on that host.'
            : 'Adding accounts from another device is not available on Windows hosts yet. Run `orca account add` in a terminal on that host.',
      startKey: (accountId) => accountId,
      acceptsPrompt: (provider, prompt) => isHostAccountSignInPage(provider, prompt.url),
      acceptsCode: (prompt) => prompt?.needsCode === true,
      describeFailure,
      busyMessage:
        'Another account sign-in is already running on this host. Finish or cancel it first.'
    })
  }
}

function describeFailure(raw: string): { error: string; errorCode?: string } {
  const message = stripAnsiEscapeSequences(raw).trim()
  // Without our cancel, login cancellation means another host account action superseded this flow.
  if (LOGIN_CANCELLED_MESSAGES.has(message)) {
    return { error: HOST_ACCOUNT_SIGN_IN_FAILURE_COPY.superseded, errorCode: 'superseded' }
  }
  return {
    error: message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
  }
}
