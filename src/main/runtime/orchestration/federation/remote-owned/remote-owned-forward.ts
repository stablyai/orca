import type { ResolvedBotWorkTargetPlacement } from '../../../../../shared/agent-session/work-target/agent-session-work-target'
import { isOrchestrationMutation } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationMethodAccessDeclaration } from '../../../rpc/methods/orchestration/access/orchestration-method-access'
import type { RemoteRunLinkRow } from '../../db/remote-owned/remote-run-links'
import { inServerTerms } from './remote-owned-answers'
import { callRemoteOwnedServer } from './remote-owned-calls'
import type { RemoteForwardKey } from './remote-forward-caller'
import { remoteServerName } from './remote-owned-reads'
import { explainRemoteServerFailure } from './remote-server-unreachable'

// Long enough for a send that starts a follow-up worker there and waits for it to be ready.
const FORWARD_TIMEOUT_MS = 180_000
// A read gives up soon on a sleeping server, whose socket stays open.
export const REMOTE_OWNED_READ_TIMEOUT_MS = 5_000

type Values = Record<string, unknown>

/** This Orca's caller, Run and server fields mean nothing there: the server names the caller itself. */
export function paramsForRemoteOwnedServer(
  access: OrchestrationMethodAccessDeclaration,
  values: Values
): Values {
  const local = new Set<string>(
    [
      access.caller,
      access.callerPane,
      access.server,
      ...Object.entries(access.targets)
        .filter(([, kind]) => kind === 'run')
        .map(([field]) => field)
    ].filter((field): field is string => field !== undefined)
  )
  return Object.fromEntries(Object.entries(values).filter(([field]) => !local.has(field)))
}

export async function forwardToRemoteOwnedLink(
  runtime: OrcaRuntimeService,
  { link, dispatchId }: { link: RemoteRunLinkRow; dispatchId?: string },
  method: string,
  access: OrchestrationMethodAccessDeclaration,
  values: Values,
  options?: {
    forward?: RemoteForwardKey
    peerWorkTarget?: ResolvedBotWorkTargetPlacement
    onAnswer?: (answer: unknown) => void
  }
): Promise<unknown> {
  const server = await remoteServerName(runtime, link.environment_id)
  const params = paramsForRemoteOwnedServer(access, values)
  try {
    const answer = await callRemoteOwnedServer(runtime, link, {
      method,
      params,
      timeoutMs: isOrchestrationMutation(method, params)
        ? FORWARD_TIMEOUT_MS
        : REMOTE_OWNED_READ_TIMEOUT_MS,
      ...(options?.forward ? { requestId: options.forward.key } : {}),
      ...(options?.peerWorkTarget ? { peerWorkTarget: options.peerWorkTarget } : {}),
      whileLink: ['open']
    })
    options?.onAnswer?.(answer)
    return inServerTerms(answer, { server, forward: options?.forward, link })
  } catch (error) {
    throw inServerTerms(explainRemoteServerFailure(error, { server, method, params, dispatchId }), {
      server,
      forward: options?.forward,
      link
    })
  }
}
