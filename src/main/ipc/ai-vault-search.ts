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
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { requestActiveSshSessionSearch } from './ssh'
import { clearSessionSearchInService } from '../ai-vault/session-scanner-service-spawn'
import { searchAllExecutionHosts, type SessionSearchHostLeg } from './ai-vault-search-all-hosts'
import {
  getActiveRuntimeAiVaultHostInfosResult,
  getActiveSshAiVaultHostInfosResult
} from './ai-vault'
import { AI_VAULT_ALL_HOST_TIMEOUT_MS } from './ai-vault-all-host-timeouts'

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
    const request = AiVaultSearchRequestSchema.parse(raw)
    // Only the desktop fans out: a runtime or CLI caller would make it two hops.
    if (scopeSchema.parse(rawScope) === ALL_EXECUTION_HOSTS_SCOPE) {
      return searchAllExecutionHosts(request, allExecutionHostLegs())
    }
    return searchByExecutionHostScope(request, requestedSearchScope(rawScope))
  })
  ipcMain.handle('aiVault:searchStatus', async (_event, rawScope?: unknown) => {
    const scope = requestedSearchScope(rawScope)
    return statusByExecutionHost(scope)
  })
  ipcMain.handle('aiVault:clearSearchIndex', () => clearSessionSearchInService())
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

/**
 * Every host the session list's `all` scope would enumerate, in one leg each.
 * A broken enumerator already degrades to an empty list rather than throwing,
 * so one unusable host class costs its own rows and not the merge.
 */
function allExecutionHostLegs(): SessionSearchHostLeg[] {
  const localLeg: SessionSearchHostLeg = {
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    search: (request) => searchSessionService(request, 'ipc')
  }
  const sshLegs = getActiveSshAiVaultHostInfosResult().hostInfos.map(({ targetId }) =>
    remoteHostLeg({ kind: 'ssh', id: toSshExecutionHostId(targetId), targetId })
  )
  const runtimeLegs = getActiveRuntimeAiVaultHostInfosResult().hostInfos.map((hostInfo) =>
    remoteHostLeg({
      kind: 'runtime',
      id: hostInfo.executionHostId,
      environmentId: hostInfo.environmentId
    })
  )
  return [localLeg, ...sshLegs, ...runtimeLegs]
}

function remoteHostLeg(host: ParsedExecutionHost): SessionSearchHostLeg {
  const client = remoteSearchClient(host, handlerOptions.callRuntimeSearch)
  return {
    executionHostId: host.id,
    timeoutMs: AI_VAULT_ALL_HOST_TIMEOUT_MS.search,
    search: (request) =>
      client
        ? client.searchSessions(request)
        : Promise.resolve({ kind: 'unavailable', reason: 'no-service' })
  }
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
