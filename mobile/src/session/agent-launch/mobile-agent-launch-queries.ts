import { useMemo } from 'react'
import { useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useOptionalHostProtocolGates } from '../../components/host-protocol-gates-context'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { defineHostQuery, useHostQuery } from '../../query/host-query'
import {
  hostQueryKey,
  type HostQueryParams,
  type HostQueryTarget
} from '../../query/host-query-key'
import { hostReadClient } from '../../query/host-read-client'
import { useHostSettingsChangeSignal } from '../../query/settings-change-signal'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { newTabSettingsRead } from './mobile-new-tab-settings-operations'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileDetectedAgents,
  MobileWorkspaceOnOtherRuntimeError,
  type MobileAgentLaunchContext,
  type MobileAgentRefresh
} from './mobile-new-tab-agent-loader'

type DetectionInput = { refusesOtherRuntime: boolean }

// Another runtime's workspace is an answer, not a failure: it replaces any agents listed before.
export type MobileDetectedAgents =
  | ({ kind: 'detected' } & Pick<MobileAgentLaunchContext, 'detectedAgents' | 'repo'>)
  | { kind: 'other-runtime' }

async function detectAgents(
  client: RpcClient,
  target: HostQueryTarget,
  input: DetectionInput,
  refresh?: MobileAgentRefresh
): Promise<MobileDetectedAgents> {
  try {
    const detected = await loadMobileDetectedAgents({
      client,
      worktreeId: target.worktree ?? '',
      hostRefusesOtherRuntime: input.refusesOtherRuntime,
      refresh
    })
    return { kind: 'detected', ...detected }
  } catch (error) {
    if (error instanceof MobileWorkspaceOnOtherRuntimeError) {
      return { kind: 'other-runtime' }
    }
    throw error
  }
}

// Installs rarely change, and desktop has no signal for them; launches read live instead.
export const detectedAgentsQuery = defineHostQuery({
  family: 'agents.detected',
  staleTime: 10 * 60_000,
  gcTime: 30 * 60_000,
  fetch: (client, target, input: DetectionInput) => detectAgents(client, target, input)
})

// Rewrites the cached list after the host re-reads its login-shell PATH, as desktop's refresh does.
// Not a query read: the query would keep the refresh as its fetch for later reconnects.
export async function refreshDetectedAgents(
  queryClient: QueryClient,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  input: DetectionInput,
  onRefreshSent: () => void
): Promise<void> {
  const queryKey = hostQueryKey(host.hostId, detectedAgentsQuery.family, target, input)
  await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
  queryClient.setQueryData(
    queryKey,
    await detectAgents(hostReadClient(host.client), target, input, { onSent: onRefreshSent })
  )
}

const NO_INPUT = {}

// The launch reads the whole settings object, so any settingsChanged makes it stale.
const newTabSettingsQuery = defineHostQuery({
  family: 'settings.newTab',
  staleTime: 60_000,
  gcTime: 30 * 60_000,
  signal: { events: ['settingsChanged'] },
  fetch: async (client, _target, _input: typeof NO_INPUT) => ({
    settings: newTabSettingsRead.interpret(await newTabSettingsRead.request(client))()
  })
})

// A host without settingsChanged gets a reread on every sheet open; the cached ones paint meanwhile.
export function reloadNewTabSettings(
  queryClient: QueryClient,
  hostId: string,
  exec: HostQueryTarget['exec']
): void {
  void queryClient.invalidateQueries(
    { queryKey: hostQueryKey(hostId, newTabSettingsQuery.family, { exec }, NO_INPUT), exact: true },
    { cancelRefetch: false }
  )
}

type MobileAgentLaunchQueries = {
  detection: UseQueryResult<MobileDetectedAgents>
  settings: UseQueryResult<{ settings: unknown }>
  target: HostQueryTarget
  input: DetectionInput
  // The host tells this page when settings change, so a sheet open need not read them again.
  settingsSignalled: boolean
}

// One agent list per workspace and document, shared by the "+" sheet and the "Fix with" labels.
// `observeLoaded: false` stops observing once loaded, so a reconnect marks the list stale for the next open instead of re-reading it unseen.
export function useMobileAgentLaunchQueries(args: {
  hostId: string
  client: RpcClient | null
  worktreeId: string
  hostCapabilities: readonly string[] | null | undefined
  enabled: boolean
  observeLoaded?: boolean
}): MobileAgentLaunchQueries {
  const { hostId, client, worktreeId, observeLoaded = true } = args
  const queryClient = useQueryClient()
  const exec = useWorkspaceExecutionHost() ?? 'local'
  const refusesOtherRuntime = hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  const input = useMemo(() => ({ refusesOtherRuntime }), [refusesOtherRuntime])
  const settingsTarget = useMemo(() => ({ exec }), [exec])
  // Capabilities pick the detection path and key, so wait for the host's status rather than read twice.
  const statusPending = useOptionalHostProtocolGates()?.statusPending === true
  const enabled = args.enabled && worktreeId !== '' && !statusPending
  const observed = (family: string, queryTarget: HostQueryTarget, params: HostQueryParams) =>
    observeLoaded ||
    queryClient.getQueryData(hostQueryKey(hostId, family, queryTarget, params)) === undefined
  const detection = useHostQuery(detectedAgentsQuery, { hostId, client }, target, input, {
    enabled,
    subscribed: observed(detectedAgentsQuery.family, target, input)
  })
  const settingsSignalled = useHostSettingsChangeSignal(hostId, client)
  const settings = useHostQuery(newTabSettingsQuery, { hostId, client }, settingsTarget, NO_INPUT, {
    enabled,
    subscribed: observed(newTabSettingsQuery.family, settingsTarget, NO_INPUT),
    staleTime: settingsSignalled ? Infinity : undefined
  })
  return { detection, settings, target, input, settingsSignalled }
}

export function agentLaunchContextOf({
  detection,
  settings
}: Pick<MobileAgentLaunchQueries, 'detection' | 'settings'>): MobileAgentLaunchContext | null {
  return detection.data?.kind === 'detected' && settings.data
    ? {
        settings: settings.data.settings,
        detectedAgents: detection.data.detectedAgents,
        repo: detection.data.repo
      }
    : null
}
