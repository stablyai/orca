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
import { isCloudWorkspaceOrcad, readSessionEnvNames } from '../../../secrets/session-env-names'
import { defineMethod, type RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../callers/rpc-caller-identity'
import { verifiedCallerTerminalHandle } from '../orchestration/turn-sender'

export type SecretRequestDeps = {
  store: () => SecretRequestStore
  sessionEnvNames: () => Promise<ReadonlySet<string>>
  /** Only a cloud workspace's orcad takes requests; a desktop's local runtime refuses them. */
  enabled: () => boolean
  /** The terminal the call came from, as orcad verifies it. */
  callerTerminal: (ctx: RpcContext) => string | null
}

const defaultDeps: SecretRequestDeps = {
  store: getSecretRequestStore,
  sessionEnvNames: () => readSessionEnvNames(),
  enabled: () => isCloudWorkspaceOrcad(),
  callerTerminal: verifiedCallerTerminalHandle
}

type CallerRuntime = Pick<RpcContext['runtime'], 'getTerminalHandleAgent' | 'isKnownWorktree'>

/** Agent and worktree from the verified calling terminal; a worktree hint only if this host knows it. */
export async function resolveSecretRequestCaller(
  runtime: CallerRuntime,
  terminalHandle: string | null,
  worktreeHint: string | undefined
): Promise<{ agent: string | null; worktreeId: string | null; terminalHandle: string | null }> {
  const terminal = terminalHandle ? runtime.getTerminalHandleAgent(terminalHandle) : null
  if (terminal) {
    return { agent: terminal.agent, worktreeId: terminal.worktreeId, terminalHandle }
  }
  const worktreeId =
    worktreeHint && (await runtime.isKnownWorktree(worktreeHint)) ? worktreeHint : null
  return { agent: null, worktreeId, terminalHandle: null }
}

/** Only a person's client (desktop or paired device) answers a request, never the agent's own CLI. */
function requirePersonCaller(ctx: Pick<RpcContext, 'caller'>): void {
  if (isAgentRpcCaller(ctx.caller)) {
    throw new SecretRequestError(SECRET_REQUEST_ERRORS.forbidden)
  }
}

export function createSecretRequestMethods(deps: SecretRequestDeps = defaultDeps) {
  // Registered everywhere so the RPC catalog is one shape; accepted only on cloud orcad.
  const store = (): SecretRequestStore => {
    if (!deps.enabled()) {
      throw new SecretRequestError(SECRET_REQUEST_ERRORS.unavailable)
    }
    return deps.store()
  }
  return [
    defineMethod({
      name: SECRETS_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsRequestParamsSchema,
      handler: async (params, ctx): Promise<SecretsRequestResult> => {
        const requests = store()
        const caller = await resolveSecretRequestCaller(
          ctx.runtime,
          deps.callerTerminal(ctx),
          params.worktreeId
        )
        return requests.request({
          name: params.name,
          reason: params.reason,
          scope: params.scope,
          ...caller,
          sessionEnvNames: await deps.sessionEnvNames()
        })
      }
    }),
    defineMethod({
      name: SECRETS_REQUEST_STATUS_METHOD,
      permission: 'workspace',
      params: SecretsRequestIdParamsSchema,
      handler: async (params): Promise<SecretsRequestStatusResult> =>
        store().status(params.requestId)
    }),
    defineMethod({
      name: SECRETS_TOUCH_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsRequestIdParamsSchema,
      handler: async (params, ctx): Promise<SecretsTouchRequestResult> => {
        requirePersonCaller(ctx)
        return store().touch(params.requestId)
      }
    }),
    defineMethod({
      name: SECRETS_RESOLVE_REQUEST_METHOD,
      permission: 'workspace',
      params: SecretsResolveRequestParamsSchema,
      handler: async (params, ctx): Promise<SecretsResolveRequestResult> => {
        requirePersonCaller(ctx)
        return store().resolve(params.requestId, params.outcome)
      }
    })
  ]
}

export const SECRET_REQUEST_METHODS = createSecretRequestMethods()
