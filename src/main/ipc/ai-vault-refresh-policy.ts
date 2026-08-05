import type { AiVaultListArgs } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'

export function shouldBypassAiVaultMergedCache(args: AiVaultListArgs | undefined): boolean {
  return (
    args?.force === true ||
    args?.refreshReason === 'manual' ||
    (args?.refreshReason === 'session-start' && Boolean(args.refreshExecutionHostId))
  )
}

export function shouldForceAiVaultHost(
  args: AiVaultListArgs | undefined,
  executionHostId: ExecutionHostId
): boolean {
  if (args?.force === true || args?.refreshReason === 'manual') {
    return true
  }
  if (args?.refreshReason === 'passive' && executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  return args?.refreshReason === 'session-start' && args.refreshExecutionHostId === executionHostId
}
