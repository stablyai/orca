import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { withSpan } from '../observability/tracer'
import { getSessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import { AiVaultScannerWorkerClient } from './session-scanner-worker-client'
import type { AiVaultWorkerData, AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'
import type { AiVaultServiceSearchRequest } from './session-scanner-service-protocol'
import { getSessionSearchInitOptions } from '../ai-vault-search/session-search-paths'
import type { AiVaultSearchCoverage, AiVaultSearchResult } from '../../shared/ai-vault-search-types'

const WORKER_ENTRY_FILENAME = 'session-scanner-worker-entry.js'

function defaultWorkerFactory(): Worker {
  const workerPath = join(__dirname, WORKER_ENTRY_FILENAME)
  if (!existsSync(workerPath)) {
    throw new Error(`AI Vault scanner worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath, {
    workerData: {
      sessionParseCache: getSessionParseCachePersistenceOptions(),
      sessionSearch: getSessionSearchInitOptions()
    } satisfies AiVaultWorkerData
  })
}

let sharedClient: AiVaultScannerWorkerClient | null = null

function getSharedClient(): AiVaultScannerWorkerClient {
  sharedClient ??= new AiVaultScannerWorkerClient({ workerFactory: defaultWorkerFactory })
  return sharedClient
}

export async function scanAiVaultSessionsInWorker(
  options: AiVaultWorkerScanOptions,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  return withSpan('aiVault.scan.worker', async (span) => {
    const { result, durationMs } = await getSharedClient().scan(options, signal)
    span.setAttribute('workerDurationMs', durationMs)
    span.setAttribute('sessions', result.sessions.length)
    return result
  })
}

export function resolveAiVaultSessionTitlesInWorker(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitlesResult> {
  return getSharedClient().resolveTitles(requests, signal)
}

export function searchAiVaultSessionsInWorker(
  request: AiVaultServiceSearchRequest,
  signal?: AbortSignal
): Promise<AiVaultSearchResult> {
  return getSharedClient().search(request, signal)
}

export function readAiVaultSearchCoverageInWorker(
  request: Pick<AiVaultServiceSearchRequest, 'roots'>
): Promise<AiVaultSearchCoverage> {
  return getSharedClient().searchCoverage(request)
}

export function resetAiVaultScannerWorkerForTests(): void {
  sharedClient?.dispose()
  sharedClient = null
}
