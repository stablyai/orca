import { z } from 'zod'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { reportAfterClosedConnection } from './managed-server-reconnect'

const UNSUPPORTED_MESSAGE =
  'This Orca runtime cannot manage servers over SSH. Run this on the computer whose Orca desktop app deployed the server, after updating Orca there.'

// Windows promotion and readiness waits can take ten minutes; allow headroom on slow hosts.
const MANAGED_SERVER_ACTION_TIMEOUT_MS = 20 * 60_000
// Same budget as the client's default for a separate status read.
const MANAGED_SERVER_STATUS_TIMEOUT_MS = 60_000
const READ_ONLY_METHODS = new Set(['managedServer.status'])
const CapabilityStatus = z.object({ capabilities: z.array(z.string()).optional() })

function unsupported(): RuntimeClientError {
  return new RuntimeClientError('incompatible_runtime', UNSUPPORTED_MESSAGE)
}

/** Sends the action only to a runtime whose status, read on the same connection, lists `capability`. */
export type SameConnectionRequirement = { capability: string; missing: () => RuntimeClientError }

export async function callManagedServer<TResult>(
  { client }: HandlerContext,
  method: string,
  params: Record<string, unknown>,
  requirement?: SameConnectionRequirement,
  onDispatch?: () => void
): Promise<RuntimeRpcSuccess<TResult>> {
  const readOnly = READ_ONLY_METHODS.has(method)
  // Without a requirement nothing marks the write, so every failure keeps main's handling.
  let dispatched = requirement === undefined
  if (!requirement) {
    const status = await client.call<RuntimeStatus>('status.get')
    if (!status.result.capabilities?.includes(MANAGED_SERVER_RUNTIME_CAPABILITY)) {
      throw unsupported()
    }
  }
  const requestSelection = requirement && {
    paramsForStatus: (raw: unknown) => {
      const status = CapabilityStatus.safeParse(raw)
      if (!status.success) {
        throw new RuntimeClientError(
          'invalid_runtime_response',
          'The Orca runtime returned an invalid status, so nothing was sent.'
        )
      }
      const capabilities = status.data.capabilities ?? []
      if (!capabilities.includes(MANAGED_SERVER_RUNTIME_CAPABILITY)) {
        throw unsupported()
      }
      if (!capabilities.includes(requirement.capability)) {
        throw requirement.missing()
      }
      return params
    },
    onDispatch: () => {
      dispatched = true
      onDispatch?.()
    }
  }
  try {
    return await client.call<TResult>(method, params, {
      ...(readOnly ? {} : { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }),
      ...(requestSelection
        ? { requestSelection, selectionStatusTimeoutMs: MANAGED_SERVER_STATUS_TIMEOUT_MS }
        : {})
    })
  } catch (error) {
    // Only the action's own method can be missing on an older host; a failed status keeps its code.
    if (dispatched && error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw unsupported()
    }
    // The runtime continues the action after this client times out.
    if (
      dispatched &&
      !readOnly &&
      error instanceof RuntimeClientError &&
      error.code === 'runtime_timeout'
    ) {
      throw new RuntimeClientError(
        'managed_server_in_progress',
        'Stopped waiting, but the desktop may still be running this action. Check `orca environment status` before retrying.'
      )
    }
    throw error
  }
}

/** Null once the restart's outcome was reported from status instead. */
export async function callExpectingRestart<TResult>(
  context: HandlerContext,
  method: string,
  params: { selector: string } & Record<string, unknown>,
  requirement?: SameConnectionRequirement
): Promise<RuntimeRpcSuccess<TResult> | null> {
  let dispatched = requirement === undefined
  try {
    return await callManagedServer<TResult>(context, method, params, requirement, () => {
      dispatched = true
    })
  } catch (error) {
    // With a requirement, a connection lost before the action could be written is a failed check, not a restart.
    if (
      !dispatched ||
      !(error instanceof RuntimeClientError) ||
      error.code !== 'runtime_unavailable'
    ) {
      throw error
    }
    await reportAfterClosedConnection(context, { selector: params.selector })
    return null
  }
}
