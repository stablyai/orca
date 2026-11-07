import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import {
  normalizeUsageSnapshot,
  USAGE_PROVIDERS,
  type UsageProviderId,
  type UsageProviderReport,
  type UsageRange,
  type UsageScope
} from './usage-report-model'

// Rows are normalized field by field with defaults, so forward the snapshot opaquely.
const usageSnapshotSchema = z.unknown()

export const usageSnapshotRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'usage.snapshot-or-skip',
    method: 'usage.snapshot',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('usage-snapshot', usageSnapshotSchema)
  })
)

export type UsageReportFetch =
  | { status: 'ok'; providers: Record<UsageProviderId, UsageProviderReport> }
  | { status: 'unsupported' }

// A desktop older than this build has no usage.snapshot; say "update the desktop" instead of showing zeros.
export async function fetchUsageReport(
  client: RpcClient,
  scope: UsageScope,
  range: UsageRange
): Promise<UsageReportFetch> {
  const replies = await Promise.all(
    USAGE_PROVIDERS.map((provider) =>
      usageSnapshotRead.request(client, { provider, scope, range, limit: 10 })
    )
  )
  if (
    replies.some(
      (reply) =>
        !reply.ok &&
        (reply.error?.code === 'method_not_found' ||
          (reply.error?.message ?? '').includes('not available to mobile clients'))
    )
  ) {
    return { status: 'unsupported' }
  }
  const providers = {} as Record<UsageProviderId, UsageProviderReport>
  USAGE_PROVIDERS.forEach((provider, index) => {
    const verdict = usageSnapshotRead.interpret(replies[index]!)
    providers[provider] = normalizeUsageSnapshot(provider, verdict.accepted ? verdict.value : null)
  })
  return { status: 'ok', providers }
}
