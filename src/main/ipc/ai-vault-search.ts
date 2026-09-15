import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../ai-vault-search/session-search-service-registry'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { requestActiveSshSessionSearch } from './ssh'

export type RuntimeSessionSearchCall = (
  environmentId: string,
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>

export type AiVaultSearchHandlerOptions = {
  callRuntimeSearch?: RuntimeSessionSearchCall
}

// One wording with the session list, which refuses the same unroutable scope.
const UNROUTABLE_HOST_MESSAGE = 'Agent Session History is not available for this execution host.'

const scopeSchema = z.string().min(1).optional()

let handlerOptions: AiVaultSearchHandlerOptions = {}

export function registerAiVaultSearchHandlers(options: AiVaultSearchHandlerOptions = {}): void {
  handlerOptions = options
  // Async so a refused scope reaches the renderer as a rejection, like every other parse failure.
  ipcMain.handle('aiVault:searchSessions', async (_event, raw: unknown, rawScope?: unknown) => {
    const scope = requestedSearchScope(rawScope)

    return searchByExecutionHostScope(AiVaultSearchRequestSchema.parse(raw), scope)
  })
  ipcMain.handle('aiVault:searchStatus', async (_event, rawScope?: unknown) => {
    const scope = requestedSearchScope(rawScope)

    return statusByExecutionHost(scope)
  })
}

/**
 * Why not the list's `requestedExecutionHostScope`: it normalizes an unparseable
 * id to `all`, which would answer an unroutable request by searching every host.
 * Same parser, same omitted-means-this-host rule, but garbage is refused.
 */
function requestedSearchScope(raw: unknown): ParsedExecutionHost {
  const value = scopeSchema.parse(raw)

  if (value === undefined) {
    return { kind: 'local', id: LOCAL_EXECUTION_HOST_ID }
  }

  const parsed = parseExecutionHostId(value)

  if (!parsed) {
    throw new Error(UNROUTABLE_HOST_MESSAGE)
  }

  return parsed
}

async function searchByExecutionHostScope(
  request: AiVaultSearchRequest,
  scope: ParsedExecutionHost
): Promise<AiVaultSearchResponse> {
  if (scope.kind === 'local') {
    return searchSessionService(request, 'ipc')
  }

  const client = remoteSearchClient(scope, handlerOptions.callRuntimeSearch)

  if (!client) {
    return { kind: 'unavailable', reason: 'no-service' }
  }

  const response = await client.searchSessions(request)

  // This desktop owns which remote host was addressed.
  return response.kind === 'results'
    ? { ...response, hits: response.hits.map((hit) => ({ ...hit, executionHostId: scope.id })) }
    : response
}

function statusByExecutionHost(scope: ParsedExecutionHost): Promise<AiVaultSearchStatus> {
  if (scope.kind === 'local') {
    return sessionSearchServiceStatus({}, 'ipc')
  }

  const client = remoteSearchClient(scope, handlerOptions.callRuntimeSearch)

  return client ? client.searchStatus() : Promise.resolve(unavailableSessionSearchStatus())
}

// Null for the local host and for a runtime environment with no injected transport.
function remoteSearchClient(
  host: ParsedExecutionHost,
  call: RuntimeSessionSearchCall | undefined
): ReturnType<typeof createSessionSearchClient> | null {
  if (host.kind === 'ssh') {
    const { targetId } = host

    return createSessionSearchClient(
      (method, params) => requestActiveSshSessionSearch(targetId, method, params),
      'relay'
    )
  }

  if (host.kind === 'runtime' && call) {
    const { environmentId } = host

    return createSessionSearchClient(
      (method, params) => call(environmentId, method, params),
      'relay'
    )
  }

  return null
}
