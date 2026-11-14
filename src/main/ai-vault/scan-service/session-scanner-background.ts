import type { AiVaultRowObserver } from '../../../shared/ai-vault-scan-rows'
import type {
  AiVaultListResult,
  AiVaultSubagentListResult,
  AiVaultFirstUserPromptResult as ReadAiVaultFirstUserPromptResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-title'
import type { ReadAiVaultFirstUserPromptArgs } from '../prompts/session-first-user-prompt-read'

import {
  clearAiVaultServiceRestartCircuit,
  invalidateAiVaultServiceCache,
  listAiVaultSubagentSessionsInService,
  readAiVaultFirstUserPromptInService,
  resetAiVaultScannerServiceForTests,
  resolveAiVaultSessionTitlesInService,
  scanAiVaultSessionsInService
} from './session-scanner-service-spawn'
import type {
  AiVaultServiceScanOptions,
  AiVaultServiceSubagentRequest
} from './session-scanner-service-protocol'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { LocalAiVaultScanProgressHandle } from '../scan-lifecycle/ai-vault-local-scan-progress'

// Let forced refreshes retry after a local service circuit opens.
export function clearAiVaultBackgroundRestartCircuit(): void {
  clearAiVaultServiceRestartCircuit()
}

export function scanAiVaultSessionsInBackground(
  options: AiVaultServiceScanOptions,
  signal?: AbortSignal,
  progress?: LocalAiVaultScanProgressHandle,
  rows?: AiVaultRowObserver
): Promise<AiVaultListResult> {
  return scanAiVaultSessionsInService(options, signal, progress, rows)
}

export function resolveAiVaultSessionTitlesInBackground(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitlesResult> {
  return resolveAiVaultSessionTitlesInService(requests, signal)
}

export function listAiVaultSubagentSessionsInBackground(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  return listAiVaultSubagentSessionsInService(request)
}

export async function readAiVaultFirstUserPromptInBackground(
  request: ReadAiVaultFirstUserPromptArgs
): Promise<ReadAiVaultFirstUserPromptResult> {
  if (process.platform === 'win32' && isWslUncPath(request.filePath)) {
    const { localAiVaultScanRoots } = await import('../discovery/ai-vault-scan-roots')
    const roots = await localAiVaultScanRoots()
    request = { ...request, wslOpenCodeReaders: roots.wslOpenCodeReaders ?? [] }
  }
  return readAiVaultFirstUserPromptInService(request)
}

export function invalidateAiVaultBackgroundCache(paths: string[]): Promise<void> {
  return invalidateAiVaultServiceCache(paths)
}

export function resetAiVaultScannerBackgroundForTests(): void {
  resetAiVaultScannerServiceForTests()
}
