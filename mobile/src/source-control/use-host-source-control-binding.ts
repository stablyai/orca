import { useCallback, useMemo } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import { DEFAULT_MOBILE_PR_SHELL_OPERATIONS } from '../platform/default-mobile-pr-shell-operations'
import { DEFAULT_HOST_SOURCE_CONTROL_FEEDBACK } from './default-host-source-control-feedback'
import type { HostSourceControlBinding } from './host-source-control-binding'

export function useHostSourceControlBinding(
  hostId: string,
  binding: HostSourceControlBinding | undefined
) {
  const insets = useSafeAreaInsets()
  const nativeHost = useHostClient(binding ? undefined : hostId)
  const nativeForceReconnect = useForceReconnect()
  const prShellOperations = useMemo(
    () =>
      binding
        ? {
            ...binding.feedback,
            writeClipboard: binding.writeClipboard,
            openExternal: binding.openExternalUrl
          }
        : DEFAULT_MOBILE_PR_SHELL_OPERATIONS,
    [binding]
  )
  const forceReconnect = useCallback(
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
    client: binding ? binding.client : nativeHost.client,
    connState: binding ? binding.connectionState : nativeHost.state,
    forceReconnect,
    feedback: binding?.feedback ?? DEFAULT_HOST_SOURCE_CONTROL_FEEDBACK,
    prShellOperations,
    insets
  }
}
