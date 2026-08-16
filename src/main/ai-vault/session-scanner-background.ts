import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  readAiVaultFirstUserPrompt,
  type ReadAiVaultFirstUserPromptArgs,
  type ReadAiVaultFirstUserPromptResult
} from './session-first-user-prompt-read'
import {
  invalidateAiVaultServiceCache,
  listAiVaultSubagentSessionsInService,
  readAiVaultFirstUserPromptInService,
  resetAiVaultScannerServiceForTests,
  resolveAiVaultSessionTitlesInService,
  scanAiVaultSessionsInService
} from './session-scanner-service-spawn'
import type { AiVaultServiceSubagentRequest } from './session-scanner-service-protocol'
import {
  resetAiVaultScannerWorkerForTests,
  resolveAiVaultSessionTitlesInWorker,
  scanAiVaultSessionsInWorker
} from './session-scanner-worker-spawn'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'
import { listLocalAiVaultSubagentSessions } from './session-subagent-reader'

export function shouldUseAiVaultServiceProcess(): boolean {
  const configured = process.env.ORCA_AI_VAULT_SERVICE_PROCESS
  if (configured === '1') {
    return true
  }
  if (configured === '0') {
    return false
  }
  return process.env.NODE_ENV !== 'test'
}

export function scanAiVaultSessionsInBackground(
  options: AiVaultWorkerScanOptions,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  return shouldUseAiVaultServiceProcess()
    ? scanAiVaultSessionsInService(options, signal)
    : scanAiVaultSessionsInWorker(options, signal)
}

export function resolveAiVaultSessionTitlesInBackground(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitlesResult> {
  return shouldUseAiVaultServiceProcess()
    ? resolveAiVaultSessionTitlesInService(requests, signal)
    : resolveAiVaultSessionTitlesInWorker(requests, signal)
}

export function listAiVaultSubagentSessionsInBackground(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  return shouldUseAiVaultServiceProcess()
    ? listAiVaultSubagentSessionsInService(request)
    : listLocalAiVaultSubagentSessions(request)
}

export function readAiVaultFirstUserPromptInBackground(
  request: ReadAiVaultFirstUserPromptArgs
): Promise<ReadAiVaultFirstUserPromptResult> {
  return shouldUseAiVaultServiceProcess()
    ? readAiVaultFirstUserPromptInService(request)
    : readAiVaultFirstUserPrompt(request)
}

export function invalidateAiVaultBackgroundCache(paths: string[]): Promise<void> {
  return shouldUseAiVaultServiceProcess() ? invalidateAiVaultServiceCache(paths) : Promise.resolve()
}

export function resetAiVaultScannerBackgroundForTests(): void {
  resetAiVaultScannerServiceForTests()
  resetAiVaultScannerWorkerForTests()
}
