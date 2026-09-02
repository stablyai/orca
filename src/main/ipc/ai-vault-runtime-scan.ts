import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import {
  abandonRemoteSessionScanOnCancel,
  throwIfAiVaultScanCancelled
} from '../ai-vault/ai-vault-scan-cancellation'
import { aiVaultScanIssueResult } from '../ai-vault/session-list-results'

export type RuntimeAiVaultHostInfo = {
  environmentId: string
  executionHostId: `runtime:${string}`
}

export type RuntimeAiVaultScanOptions = {
  timeoutMs?: number
}

export type RuntimeAiVaultScanner = (
  environmentId: string,
  args: AiVaultListArgs,
  options?: RuntimeAiVaultScanOptions
) => Promise<AiVaultListResult>

/**
 * Why: an unreachable Orca server must cost this host's row, not the whole
 * multi-host list, so every failure except cancellation degrades to an issue.
 */
export async function scanRuntimeAiVaultSessions(args: {
  hostInfo: RuntimeAiVaultHostInfo
  scanner: RuntimeAiVaultScanner | undefined
  listArgs?: AiVaultListArgs
  options?: RuntimeAiVaultScanOptions & { signal?: AbortSignal }
}): Promise<AiVaultListResult> {
  const { signal, ...scannerOptions } = args.options ?? {}
  throwIfAiVaultScanCancelled(signal)
  if (!args.scanner) {
    return runtimeScanIssueResult(
      args.hostInfo,
      'Agent Session History is not available for this execution host.'
    )
  }
  try {
    return await abandonRemoteSessionScanOnCancel(
      args.scanner(args.hostInfo.environmentId, runtimeScanArgs(args.hostInfo, args.listArgs), {
        ...scannerOptions
      }),
      signal
    )
  } catch (error) {
    // RPC rejections keep the message but lose Error.name, so classify on both.
    if (isAiVaultScanCancelledError(error)) {
      throw error
    }
    return runtimeScanIssueResult(
      args.hostInfo,
      error instanceof Error ? error.message : 'Remote Orca server is unavailable.'
    )
  }
}

// Optional keys are copied only when present so the RPC schema never sees an
// explicit undefined for limit/force/scopePaths.
function runtimeScanArgs(
  hostInfo: RuntimeAiVaultHostInfo,
  listArgs: AiVaultListArgs | undefined
): AiVaultListArgs {
  const scanArgs: AiVaultListArgs = { executionHostScope: hostInfo.executionHostId }
  if (listArgs?.limit !== undefined) {
    scanArgs.limit = listArgs.limit
  }
  if (listArgs?.unlimited !== undefined) {
    scanArgs.unlimited = listArgs.unlimited
  }
  if (listArgs?.force !== undefined) {
    scanArgs.force = listArgs.force
  }
  if (listArgs?.scopePaths !== undefined) {
    scanArgs.scopePaths = listArgs.scopePaths
  }
  return scanArgs
}

function runtimeScanIssueResult(
  hostInfo: RuntimeAiVaultHostInfo,
  message: string
): AiVaultListResult {
  return aiVaultScanIssueResult({
    executionHostId: hostInfo.executionHostId,
    path: hostInfo.environmentId,
    message
  })
}
