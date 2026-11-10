import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import {
  SECRET_REQUEST_ERRORS,
  SECRET_REQUEST_REASON_MAX,
  SECRETS_REQUEST_METHOD,
  SECRETS_REQUEST_STATUS_METHOD,
  secretReloadHint,
  type SecretRequestScope,
  type SecretRequestStatus,
  type SecretsRequestParams,
  type SecretsRequestResult,
  type SecretsRequestStatusResult
} from '../../shared/secret-request-contract'

const DEFAULT_WAIT_SEC = 900
const MAX_WAIT_SEC = 3600
const POLL_MS = 2000

export type SecretRequestOutcome = SecretRequestStatus | 'already-set'

export type SecretRequestCliDeps = {
  call: <T>(method: string, params: unknown) => Promise<T>
  sleep: (ms: number) => Promise<void>
  now: () => number
  print: (line: string) => void
}

export type SecretRequestCliInput = {
  name: string
  reason: string
  scope?: SecretRequestScope
  waitSec: number | null
  json: boolean
  terminalHandle?: string
  worktreeId?: string
}

/** Returns the exit code. */
export async function runSecretRequest(
  input: SecretRequestCliInput,
  deps: SecretRequestCliDeps
): Promise<number> {
  const params: SecretsRequestParams = {
    name: input.name,
    reason: input.reason,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    ...(input.terminalHandle ? { terminalHandle: input.terminalHandle } : {})
  }
  let created: SecretsRequestResult
  try {
    created = await deps.call<SecretsRequestResult>(SECRETS_REQUEST_METHOD, params)
  } catch (error) {
    throw explainRequestError(error, input.name)
  }
  if (created.status === 'already-set') {
    return finish(input, deps, { requestId: null, status: 'already-set' })
  }
  const requestId = created.requestId
  if (input.waitSec === null) {
    return finish(input, deps, { requestId, status: 'pending' })
  }
  const deadline = deps.now() + input.waitSec * 1000
  for (;;) {
    const current = await deps.call<SecretsRequestStatusResult>(SECRETS_REQUEST_STATUS_METHOD, {
      requestId
    })
    if (current.status !== 'pending' || deps.now() >= deadline) {
      return finish(input, deps, { requestId, status: current.status, waited: true })
    }
    await deps.sleep(Math.min(POLL_MS, Math.max(0, deadline - deps.now())))
  }
}

function finish(
  input: SecretRequestCliInput,
  deps: SecretRequestCliDeps,
  result: { requestId: string | null; status: SecretRequestOutcome; waited?: boolean }
): number {
  const answered = result.status === 'provided' || result.status === 'already-set'
  const exitCode = answered || (result.status === 'pending' && !result.waited) ? 0 : 1
  if (input.json) {
    deps.print(
      JSON.stringify(
        {
          requestId: result.requestId,
          name: input.name,
          status: result.status,
          ...(result.status === 'provided' || result.status === 'already-set'
            ? { hint: secretReloadHint(input.name) }
            : {})
        },
        null,
        2
      )
    )
    return exitCode
  }
  deps.print(formatSecretRequestOutcome(input.name, result.requestId, result.status, result.waited))
  return exitCode
}

export function formatSecretRequestOutcome(
  name: string,
  requestId: string | null,
  status: SecretRequestOutcome,
  waited = false
): string {
  switch (status) {
    case 'provided':
      return secretReloadHint(name)
    case 'already-set':
      return `${name} is already set in this workspace. If this shell doesn't have it yet: eval "$(orca-env)" (fish: orca-env --fish | source).`
    case 'declined':
      return `The person declined to provide ${name}.`
    case 'expired':
      return `The request for ${name} expired before anyone answered it.`
    case 'pending':
      return waited
        ? `Still waiting for ${name} (${requestId}). Run the same command again to keep waiting.`
        : `Asked the person for ${name} (${requestId}). Add --wait <sec> to wait for the answer.`
  }
}

const ERROR_MESSAGES: Record<string, (name: string) => string> = {
  [SECRET_REQUEST_ERRORS.invalidName]: (name) =>
    `${name} is not a valid secret name: use A-Z, 0-9 and _, not starting with a digit.`,
  [SECRET_REQUEST_ERRORS.reservedName]: (name) =>
    `${name} is reserved: Orca or the system manages it, so it can't be a secret.`,
  [SECRET_REQUEST_ERRORS.subscriptionTokenRefused]: () =>
    'CLAUDE_CODE_OAUTH_TOKEN is never stored. Ask the person to sign Claude in instead.',
  [SECRET_REQUEST_ERRORS.agentCredential]: (name) =>
    `${name} is an agent credential: it comes from the person's sign-in or Orca Cloud secrets and can't be requested.`,
  [SECRET_REQUEST_ERRORS.tooManyPending]: () =>
    'This workspace already has 3 secret requests waiting. Wait for one to be answered.',
  [SECRET_REQUEST_ERRORS.rateLimited]: () =>
    'This workspace asked for 10 secrets in the last hour. Try again later.'
}

function explainRequestError(error: unknown, name: string): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  const explain = ERROR_MESSAGES[error.message]
  return explain ? new RuntimeClientError(error.message, explain(name)) : error
}

export function parseSecretRequestWait(value: string | boolean | undefined): number | null {
  if (value === undefined) {
    return null
  }
  if (value === true) {
    return DEFAULT_WAIT_SEC
  }
  const seconds = Number(value)
  if (typeof value !== 'string' || !/^\d+$/.test(value) || seconds < 1) {
    throw new RuntimeClientError('invalid_argument', '--wait takes a number of seconds')
  }
  return Math.min(seconds, MAX_WAIT_SEC)
}

function parseScope(value: string | undefined): SecretRequestScope | undefined {
  if (value === undefined || value === 'personal' || value === 'repo') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', '--scope is personal or repo')
}

export const SECRET_HANDLERS: Record<string, CommandHandler> = {
  'secret request': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const reason = getRequiredStringFlag(flags, 'reason').trim()
    if (reason.length === 0 || reason.length > SECRET_REQUEST_REASON_MAX) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--reason must be 1-${SECRET_REQUEST_REASON_MAX} characters`
      )
    }
    process.exitCode = await runSecretRequest(
      {
        name,
        reason,
        scope: parseScope(getOptionalStringFlag(flags, 'scope')),
        waitSec: parseSecretRequestWait(flags.get('wait')),
        json,
        terminalHandle: process.env.ORCA_TERMINAL_HANDLE || undefined,
        worktreeId: process.env.ORCA_WORKTREE_ID || undefined
      },
      {
        call: async <T>(method: string, params: unknown) =>
          (await client.call<T>(method, params)).result,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        print: (line) => console.log(line)
      }
    )
  }
}
