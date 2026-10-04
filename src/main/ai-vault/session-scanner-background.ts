import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type {
  ReadAiVaultFirstUserPromptArgs,
  ReadAiVaultFirstUserPromptResult
} from './session-first-user-prompt-read'
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
import { isWslUncPath } from '../../shared/wsl-paths'

// Let forced refreshes retry after a local service circuit opens.
export function clearAiVaultBackgroundRestartCircuit(): void {
  clearAiVaultServiceRestartCircuit()
}

export function scanAiVaultSessionsInBackground(
  options: AiVaultServiceScanOptions,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  return scanAiVaultSessionsInService(options, signal)
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
    const { localAiVaultScanRoots } = await import('./cached-session-list')
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
