import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { DEFAULT_SOURCE_CONTROL_GROUP_ORDER } from '../../../../src/shared/source-control/listing/source-control-group-order'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { defineHostQuery, useHostQuery } from '../../query/host-query'
import { hostQueryKey } from '../../query/host-query-key'
import { settingsSignal, useHostSettingsChangeSignal } from '../../query/settings-change-signal'
import {
  SOURCE_CONTROL_SETTINGS_KEYS,
  sourceControlSettingsRead,
  type MobileSourceControlSettings
} from './mobile-source-control-settings-operations'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'

const DESKTOP_DEFAULTS: MobileSourceControlSettings = {
  groupOrder: DEFAULT_SOURCE_CONTROL_GROUP_ORDER,
  compareAgainstUpstream: false,
  diffShowWhitespace: false
}

const NO_INPUT = {}

// A host without settingsChanged gets a reread on every mount and foreground, behind the cached copy.
const sourceControlSettingsQuery = defineHostQuery({
  family: 'settings.sourceControl',
  staleTime: 0,
  refetchOnWindowFocus: true,
  gcTime: 30 * 60_000,
  signal: settingsSignal(SOURCE_CONTROL_SETTINGS_KEYS),
  fetch: async (
    client,
    _target,
    _input: typeof NO_INPUT,
    previous: MobileSourceControlSettings | undefined
  ) => {
    const reply = sourceControlSettingsRead.interpret(
      await sourceControlSettingsRead.request(client)
    )
    return reply.accepted ? reply.value : (previous ?? DESKTOP_DEFAULTS)
  }
})

// Desktop's Source Control and diff settings; a host starts from desktop's defaults until they arrive.
export function useMobileSourceControlSettings(
  hostId: string,
  client: RpcClient | null,
  connState: ConnectionState
): { settings: MobileSourceControlSettings; reload: () => void } {
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const signalled = useHostSettingsChangeSignal(hostId, client)
  const { data } = useHostQuery(
    sourceControlSettingsQuery,
    { hostId, client },
    { exec },
    NO_INPUT,
    { enabled: connState === 'connected', staleTime: signalled ? Infinity : undefined }
  )
  const reload = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKey(hostId, sourceControlSettingsQuery.family, { exec }, NO_INPUT)
    })
  }, [queryClient, hostId, exec])
  return { settings: data ?? DESKTOP_DEFAULTS, reload }
}
