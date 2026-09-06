import { useCallback } from 'react'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import { DEFAULT_HOST_DIFF_REVIEW_DEVICE_OPERATIONS } from './default-host-diff-review-device-operations'
import type { HostDiffReviewBinding } from './host-diff-review-binding'

export function useHostDiffReviewBinding(
  hostId: string,
  binding: HostDiffReviewBinding | undefined
) {
  const nativeHost = useHostClient(binding ? undefined : hostId)
  const nativeForceReconnect = useForceReconnect()
  const reconnect = useCallback(
    async (requestedHostId: string) => {
      if (binding) {
        await binding.reconnect()
        return
      }
      await nativeForceReconnect(requestedHostId)
    },
    [binding, nativeForceReconnect]
  )
  return {
    client: binding?.client ?? nativeHost.client,
    connectionState: binding?.connectionState ?? nativeHost.state,
    reconnect,
    device: binding?.device ?? DEFAULT_HOST_DIFF_REVIEW_DEVICE_OPERATIONS
  }
}
