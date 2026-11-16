import type { OrcaRuntimeService } from '../../../../orca-runtime'

export function workerDeliveryName(
  runtime: Pick<OrcaRuntimeService, 'orchestrationSenderNames'>,
  address: string
): string | undefined {
  return runtime.orchestrationSenderNames?.sender?.(address)?.name?.trim() || undefined
}
