import type { OrcaRuntimeService } from '../orca-runtime'

// These mutations persist their own idempotent outcome after an interrupted receipt write.
export function isResumableOrchestrationMutation(method: string): boolean {
  return (
    method === 'orchestration.federationRelease' ||
    method === 'orchestration.workerRelease' ||
    method === 'orchestration.runComplete'
  )
}

export function isRetryableFederatedRelease(
  method: string,
  params: unknown,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>
): boolean {
  if (method === 'orchestration.federationRelease') {
    return true
  }
  if (method !== 'orchestration.workerRelease') {
    return false
  }
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as { dispatch?: unknown }).dispatch === 'string' &&
    Boolean(db.getFederatedDispatch((params as { dispatch: string }).dispatch))
  )
}

export function isRetryableFederatedReleaseResult(
  retryableFederatedRelease: boolean,
  result: unknown
): boolean {
  if (!retryableFederatedRelease || !result || typeof result !== 'object') {
    return false
  }
  return (result as { state?: unknown }).state === 'unverifiable'
}

export function attestFederatedReleaseReplay(
  method: string,
  receipt: unknown,
  servingRuntimeEpoch: string
): unknown {
  if (
    method !== 'orchestration.federationRelease' ||
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt)
  ) {
    return receipt
  }
  return { ...(receipt as Record<string, unknown>), servingRuntimeEpoch }
}
