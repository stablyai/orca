// The phone's reach to the paired computer's accounts.hostSignIn* methods, for the shared run.
import * as z from 'zod'
import {
  HOST_ACCOUNT_SIGN_IN_FAILURE_COPY as FAILURE_EN,
  type HostAccountSignInFailureCode,
  type HostAccountSignInProvider
} from '../../../../src/shared/agent-accounts/host-account-sign-in-types'
import type { HostAccountSignInTransport } from '../../../../src/shared/agent-accounts/host-account-sign-in-run'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../../../src/shared/agent-accounts/codex/codex-auth-errors'
import { translate } from '../../i18n/mobile-i18n'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

const CALL_TIMEOUT_MS = 20_000

const AccountListSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({ id: z.string(), email: z.string(), displayName: z.string().optional() })
  )
})

const StatusSchema = z.looseObject({
  flowId: z.string().min(1),
  provider: z.enum(['claude', 'codex']),
  revision: z.number().int(),
  phase: z.enum(['starting', 'waiting', 'verifying', 'signedIn', 'failed', 'cancelled']),
  prompt: z
    .looseObject({
      url: z.string(),
      userCode: z.string().nullable(),
      needsCode: z.boolean()
    })
    .optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  claude: AccountListSchema.optional(),
  codex: AccountListSchema.optional()
})

export type PhoneHostAccountSignInStatus = z.infer<typeof StatusSchema>

function statusOperation<
  Method extends
    | 'accounts.hostSignInStart'
    | 'accounts.hostSignInWait'
    | 'accounts.hostSignInSubmitCode'
    | 'accounts.hostSignInCancel'
>(method: Method) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('host-account-sign-in-status', StatusSchema)
    })
  )
}

const signInStart = statusOperation('accounts.hostSignInStart')
const signInWait = statusOperation('accounts.hostSignInWait')
const signInSubmitCode = statusOperation('accounts.hostSignInSubmitCode')
const signInCancel = statusOperation('accounts.hostSignInCancel')

/** The request never got an answer: a timeout or a dropped connection, never the host's refusal. */
class LostAnswer extends Error {}

/** The host's answer, read; a request that never got one throws LostAnswer. */
async function answered<T>(
  sent: Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => T
): Promise<T> {
  const reply = await sent.catch((error: unknown) => {
    throw new LostAnswer(error instanceof Error ? error.message : String(error))
  })
  return interpret(reply)
}

const FAILURE_COPY: Record<HostAccountSignInFailureCode, () => string> = {
  ownerSilent: () => translate('accounts.hostSignIn.errors.ownerSilent', FAILURE_EN.ownerSilent),
  superseded: () => translate('accounts.hostSignIn.errors.superseded', FAILURE_EN.superseded),
  noPrompt: () => translate('accounts.hostSignIn.errors.noPrompt', FAILURE_EN.noPrompt)
}

function isFailureCode(code: unknown): code is HostAccountSignInFailureCode {
  return typeof code === 'string' && Object.hasOwn(FAILURE_COPY, code)
}

/** The host's failure in the phone's language; the login's own (uncoded) errors stay verbatim. */
function failureText(status: { error?: string; errorCode?: string }): string {
  if (isFailureCode(status.errorCode)) {
    return FAILURE_COPY[status.errorCode]()
  }
  return (
    status.error ?? translate('accounts.hostSignIn.errors.failed', 'Sign-in failed. Try again.')
  )
}

export const HOST_ACCOUNT_SIGN_IN_CANCELLED: Record<HostAccountSignInProvider, string> = {
  claude: 'Claude sign-in was cancelled.',
  codex: CODEX_LOGIN_CANCELLED_MESSAGE
}

export function phoneHostAccountSignInTransport(
  client: RpcClient,
  provider: HostAccountSignInProvider
): HostAccountSignInTransport<PhoneHostAccountSignInStatus> {
  const options = { timeoutMs: CALL_TIMEOUT_MS }
  return {
    start: (params) =>
      answered(signInStart.request(client, params, options), signInStart.interpret),
    wait: (params, timeoutMs) =>
      answered(signInWait.request(client, params, { timeoutMs }), signInWait.interpret),
    submitCode: (params) =>
      answered(signInSubmitCode.request(client, params, options), signInSubmitCode.interpret),
    cancel: (params) =>
      answered(signInCancel.request(client, params, options), signInCancel.interpret),
    isLostAnswer: (error) => error instanceof LostAnswer,
    failureText,
    cancelledText: HOST_ACCOUNT_SIGN_IN_CANCELLED[provider]
  }
}
