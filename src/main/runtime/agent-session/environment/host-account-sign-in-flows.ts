import { stripAnsiEscapeSequences } from '../../../../shared/terminal/protocol/escape/ansi-escape-sequences'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../shared/agent-accounts/codex/codex-auth-errors'
import {
  HOST_ACCOUNT_SIGN_IN_FAILURE_COPY,
  HOST_ACCOUNT_SIGN_IN_OWNER_SILENCE_MS,
  isHostAccountSignInPage,
  type HostAccountSignInChannel,
  type HostAccountSignInPrompt,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from '../../../../shared/agent-accounts/host-account-sign-in-types'
import { CallerOwnedSignInFlows } from '../../caller-owned-sign-in-flows'

const MAX_ERROR_CHARS = 600
// Claude and Codex print their link within seconds; silence past this means the link went unrecognized or the login hung.
const PROMPT_DEADLINE_MS = 60_000
// Why above a minute: a client following its flow asks at least every 35 s.
const OWNER_TAKE_OVER_MS = 60_000
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

/** Whether a client elsewhere can sign accounts in on a host running `platform`. */
export function hostAccountSignInRunsOn(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

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
        hostAccountSignInRunsOn(platform)
          ? null
          : accountId
            ? 'Signing in again from another device is not available on Windows hosts yet. Sign in again on that host.'
            : 'Adding accounts from another device is not available on Windows hosts yet. Run `orca account add` in a terminal on that host.',
      startKey: (accountId) => accountId,
      acceptsPrompt: (provider, prompt) => isHostAccountSignInPage(provider, prompt.url),
      acceptsCode: (prompt) => prompt?.needsCode === true,
      describeFailure,
      promptDeadlineMs: PROMPT_DEADLINE_MS,
      ownerSilenceMs: HOST_ACCOUNT_SIGN_IN_OWNER_SILENCE_MS,
      ownerTakesOverAfterMs: OWNER_TAKE_OVER_MS,
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
