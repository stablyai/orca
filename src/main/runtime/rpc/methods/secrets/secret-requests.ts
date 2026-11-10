import {
  SECRET_REQUEST_ERRORS,
  SECRETS_REQUEST_METHOD,
  SECRETS_REQUEST_STATUS_METHOD,
  SECRETS_RESOLVE_REQUEST_METHOD,
  SECRETS_TOUCH_REQUEST_METHOD,
  SecretsRequestIdParamsSchema,
  SecretsRequestParamsSchema,
  SecretsResolveRequestParamsSchema,
  type SecretsRequestResult,
  type SecretsRequestStatusResult,
  type SecretsResolveRequestResult,
  type SecretsTouchRequestResult
} from '../../../../../shared/secret-request-contract'
import {
  getSecretRequestStore,
  SecretRequestError,
  type SecretRequestStore
} from '../../../secrets/secret-request-store'
import { readSessionEnvNames } from '../../../secrets/session-env-names'
import { defineMethod, type RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../rpc-caller-identity'

export type SecretRequestDeps = {
  store: () => SecretRequestStore
  sessionEnvNames: () => Promise<ReadonlySet<string>>
}

const defaultDeps: SecretRequestDeps = {
  store: getSecretRequestStore,
  sessionEnvNames: () => readSessionEnvNames()
}

type TerminalAgentLookup = Pick<RpcContext['runtime'], 'getTerminalHandleAgent'>

/** The agent comes from the calling terminal's own session record; the caller can't name one. */
export function callerTerminalIdentity(
  runtime: TerminalAgentLookup,
  terminalHandle: string | undefined
): { agent: string | null; worktreeId: string | null } | null {
  if (!terminalHandle) {
    return null
  }
  return runtime.getTerminalHandleAgent(terminalHandle)
}

/** Only a person's client (desktop or paired device) answers a request, never the agent's own CLI. */
function requirePersonCaller(ctx: Pick<RpcContext, 'caller'>): void {
  if (isAgentRpcCaller(ctx.caller)) {
    throw new SecretRequestError(SECRET_REQUEST_ERRORS.forbidden)
  }
}

export function createSecretRequestMethods(deps: SecretRequestDeps = defaultDeps) {
  return [
    defineMethod({
      name: SECRETS_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsRequestParamsSchema,
      handler: async (params, ctx): Promise<SecretsRequestResult> => {
        const identity = callerTerminalIdentity(ctx.runtime, params.terminalHandle)
        return deps.store().request({
          name: params.name,
          reason: params.reason,
          scope: params.scope,
          agent: identity?.agent ?? null,
          // A resolved terminal names its own worktree; otherwise take the hint.
          worktreeId: identity?.worktreeId ?? params.worktreeId ?? null,
          terminalHandle: identity ? (params.terminalHandle ?? null) : null,
          sessionEnvNames: await deps.sessionEnvNames()
        })
      }
    }),
    defineMethod({
      name: SECRETS_REQUEST_STATUS_METHOD,
      permission: 'workspace',
      params: SecretsRequestIdParamsSchema,
      handler: async (params): Promise<SecretsRequestStatusResult> =>
        deps.store().status(params.requestId)
    }),
    defineMethod({
      name: SECRETS_TOUCH_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsRequestIdParamsSchema,
      handler: async (params, ctx): Promise<SecretsTouchRequestResult> => {
        requirePersonCaller(ctx)
        return deps.store().touch(params.requestId)
      }
    }),
    defineMethod({
      name: SECRETS_RESOLVE_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsResolveRequestParamsSchema,
      handler: async (params, ctx): Promise<SecretsResolveRequestResult> => {
        requirePersonCaller(ctx)
        return deps.store().resolve(params.requestId, params.outcome)
      }
    })
  ]
}

export const SECRET_REQUEST_METHODS = createSecretRequestMethods()
