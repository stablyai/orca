import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  measureRemoteRuntimeSubscriptionParams,
  REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTIONS
} from '../../shared/remote-runtime-memory-limits'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export type RuntimeEnvironmentSubscriptionAdmission = {
  claim: (subscriptionId: string, params: unknown) => () => void
  evidence: () => { retainedBytes: number; subscriptionCount: number }
}

export function createRuntimeEnvironmentSubscriptionAdmission(): RuntimeEnvironmentSubscriptionAdmission {
  const subscriptionIds = new Set<string>()
  let retainedBytes = 0

  return {
    claim(subscriptionId, params): () => void {
      assertSubscriptionId(subscriptionId)
      if (subscriptionIds.has(subscriptionId)) {
        throw new RemoteRuntimeClientError(
          'invalid_argument',
          'Runtime environment subscription id already exists.'
        )
      }
      if (subscriptionIds.size >= REMOTE_RUNTIME_MAX_SUBSCRIPTIONS) {
        throw new RemoteRuntimeClientError(
          'remote_runtime_busy',
          'Remote runtime subscription limit reached; close a subscription and retry.'
        )
      }
      const paramsBytes = measureRemoteRuntimeSubscriptionParams(params)
      if (retainedBytes + paramsBytes > REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES) {
        throw new RemoteRuntimeClientError(
          'remote_runtime_busy',
          'Remote runtime subscription memory limit reached; close a subscription and retry.'
        )
      }
      subscriptionIds.add(subscriptionId)
      retainedBytes += paramsBytes
      let claimed = true
      return () => {
        if (!claimed) {
          return
        }
        claimed = false
        subscriptionIds.delete(subscriptionId)
        retainedBytes -= paramsBytes
      }
    },
    evidence: () => ({ retainedBytes, subscriptionCount: subscriptionIds.size })
  }
}

function assertSubscriptionId(subscriptionId: string): void {
  if (
    subscriptionId.length === 0 ||
    measureUtf8ByteLength(subscriptionId, {
      stopAfterBytes: REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES
    }).exceededLimit
  ) {
    throw new RemoteRuntimeClientError(
      'invalid_argument',
      `Runtime environment subscription id must be between 1 and ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES} bytes.`
    )
  }
}
