import type { RuntimeClient } from './runtime-client'
import type { RuntimeRpcSuccess } from './runtime/types'
import {
  ReceivedSessionSearchResultSchema,
  SESSION_SEARCH_METHODS,
  SessionSearchStatusSchema,
  type SessionSearchOperation
} from '../shared/ai-vault-search-contract'
import type { AiVaultSearchResult } from '../shared/ai-vault-search-types'
import type { SearchCommand } from './search-command-arguments'
import { waitForPromiseWithSignal } from '../shared/abort-signal-reason'

export type SearchHost = {
  id: string
  name: string
  selector: string
  client: RuntimeClient
  targetId?: string
}
export type SearchHostResult = {
  host: Pick<SearchHost, 'id' | 'name' | 'selector'> & { runtimeId?: string }
  outcome:
    | 'searched'
    | 'disabled'
    | 'unsupported'
    | 'unavailable'
    | 'policy-unknown'
    | 'failed'
    | 'omitted'
  result?: AiVaultSearchResult
  message?: string
}
export const SEARCH_HOST_TIMEOUT_MS = 15_000
export const SEARCH_ALL_TIMEOUT_MS = 30_000
export const SEARCH_ALL_HOST_LIMIT = 16

export function searchHostMethod(
  host: Pick<SearchHost, 'targetId'>,
  operation: SessionSearchOperation
): string {
  const methods = SESSION_SEARCH_METHODS[operation]
  return host.targetId ? methods.runtimeSsh : methods.runtime
}

/**
 * The one place that knows a search host's method routing, its target spread and
 * its deadline, so the single-host and all-hosts paths cannot arm two of any of
 * them for the same call.
 */
export function createSearchHostCall(
  host: Pick<SearchHost, 'client' | 'targetId'>,
  signal: AbortSignal,
  deadline: number
): (operation: SessionSearchOperation, params?: object) => Promise<RuntimeRpcSuccess<unknown>> {
  return (operation, params = {}) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return Promise.reject(new Error('Search host deadline exceeded.'))
    }
    return waitForPromiseWithSignal(
      host.client.call(
        searchHostMethod(host, operation),
        { ...params, ...(host.targetId ? { targetId: host.targetId } : {}) },
        { timeoutMs: remaining, signal }
      ),
      signal
    )
  }
}

export async function querySearchHost(
  host: SearchHost,
  command: SearchCommand,
  aggregate: boolean,
  signal: AbortSignal,
  deadline = Date.now() + SEARCH_HOST_TIMEOUT_MS
): Promise<SearchHostResult> {
  const identity: SearchHostResult['host'] = {
    id: host.id,
    name: host.name,
    selector: host.selector
  }
  const send = createSearchHostCall(host, signal, deadline)
  const call = async (operation: SessionSearchOperation, args: object = {}): Promise<unknown> => {
    const response = await send(operation, args)
    if (response._meta?.runtimeId) {
      identity.runtimeId = response._meta.runtimeId.slice(0, 512)
    }
    return response.result
  }
  try {
    if (aggregate) {
      let raw
      try {
        raw = await call('status')
      } catch (error) {
        if (errorCode(error) === 'method_not_found') {
          return {
            host: identity,
            outcome: host.targetId ? 'unsupported' : 'policy-unknown',
            message: host.targetId
              ? 'This runtime does not provide the SSH search route.'
              : 'This host cannot report its indexing policy.'
          }
        }
        throw error
      }
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('enabled' in raw) ||
        typeof raw.enabled !== 'boolean'
      ) {
        return {
          host: identity,
          outcome: 'policy-unknown',
          message: 'This host did not report its indexing policy.'
        }
      }
      const status = SessionSearchStatusSchema.parse(raw)
      if (status.available === false) {
        return { host: identity, outcome: 'unsupported', message: status.reason }
      }
      if (status.applied === false) {
        return {
          host: identity,
          outcome: 'policy-unknown',
          message: status.reason ?? 'Index policy is not applied.'
        }
      }
      if (!status.enabled) {
        return { host: identity, outcome: 'disabled' }
      }
    }
    const result = ReceivedSessionSearchResultSchema.parse(await call('query', command.query))
    return {
      host: identity,
      outcome: result.coverage.enabled === false ? 'disabled' : 'searched',
      result
    }
  } catch (error) {
    const code = errorCode(error)
    const outcome =
      code === 'method_not_found'
        ? 'unsupported'
        : code === 'invalid_runtime_response' ||
            (error instanceof Error && error.name === 'ZodError')
          ? 'failed'
          : 'unavailable'
    return {
      host: identity,
      outcome,
      message: (error instanceof Error ? error.message : 'Search failed.').slice(0, 2048)
    }
  }
}

export function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}
