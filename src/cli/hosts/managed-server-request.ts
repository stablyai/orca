import { z } from 'zod'
import {
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { HandlerContext } from '../dispatch/dispatch'
import { DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS } from '../runtime/connection/runtime-request-timeout'
import { RuntimeClientError } from '../runtime/connection/types'
import { reportAfterClosedConnection } from './managed-server-reconnect'

const UNSUPPORTED_MESSAGE =
  'This Orca runtime cannot manage servers over SSH. Run this on the computer whose Orca desktop app deployed the server, after updating Orca there.'

const OLDER_DESKTOP_FORCE_MESSAGE =
  'Update this Orca desktop app to use limited force, or use --force --end-server-terminals to confirm that any terminals the server runs itself will end if it restarts.'

// Windows promotion and readiness waits can take ten minutes; allow headroom on slow hosts.
const MANAGED_SERVER_ACTION_TIMEOUT_MS = 20 * 60_000
const READ_ONLY_METHODS = new Set(['managedServer.status'])
const ManagedServerStatus = z.object({ capabilities: z.array(z.string()).optional() })

function unsupported(): RuntimeClientError {
  return new RuntimeClientError('incompatible_runtime', UNSUPPORTED_MESSAGE)
}

type ManagedServerRequestOptions = {
  requireLimitedForce?: boolean
  onDispatch?: () => void
}

export async function callManagedServer<TResult>(
  { client }: HandlerContext,
  method: string,
  params: Record<string, unknown>,
  options?: ManagedServerRequestOptions
): Promise<RuntimeRpcSuccess<TResult>> {
  const readOnly = READ_ONLY_METHODS.has(method)
  let dispatched = false
  try {
    return await client.call<TResult>(method, params, {
      ...(readOnly ? {} : { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }),
      requestSelection: {
        preflightTimeoutMs: DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS,
        paramsForStatus: (raw) => {
          const capabilities = ManagedServerStatus.safeParse(raw).data?.capabilities ?? []
          if (!capabilities.includes(MANAGED_SERVER_RUNTIME_CAPABILITY)) {
            throw unsupported()
          }
          if (
            options?.requireLimitedForce &&
            !capabilities.includes(MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY)
          ) {
            throw new RuntimeClientError('incompatible_runtime', OLDER_DESKTOP_FORCE_MESSAGE)
          }
          return params
        },
        onDispatch: () => {
          dispatched = true
          options?.onDispatch?.()
        }
      }
    })
  } catch (error) {
    if (!(error instanceof RuntimeClientError)) {
      throw error
    }
    if (error.code === 'method_not_found') {
      throw unsupported()
    }
    // The runtime continues the action after this client times out.
    if (dispatched && !readOnly && error.code === 'runtime_timeout') {
      throw new RuntimeClientError(
        'managed_server_in_progress',
        'Stopped waiting, but the desktop may still be running this action. Check `orca environment status` before retrying.'
      )
    }
    throw error
  }
}

export async function callExpectingRestart<TResult>(
  context: HandlerContext,
  method: string,
  params: { selector: string } & Record<string, unknown>,
  requireLimitedForce = false
): Promise<RuntimeRpcSuccess<TResult>> {
  let dispatched = false
  try {
    return await callManagedServer<TResult>(context, method, params, {
      requireLimitedForce,
      onDispatch: () => {
        dispatched = true
      }
    })
  } catch (error) {
    if (
      !dispatched ||
      !(error instanceof RuntimeClientError) ||
      error.code !== 'runtime_unavailable'
    ) {
      throw error
    }
    return reportAfterClosedConnection(context, { selector: params.selector })
  }
}
