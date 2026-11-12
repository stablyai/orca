import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { hostStatusProbe } from '../transport/connection/host-status-probe-operations'
import { hostConnectionEpoch, readHostStatusReply } from '../query/host-status-query'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import { useHostEventRouter } from '../query/host-event-router'
import { hostQueryKey, type HostQueryTarget } from '../query/host-query-key'
import { isHostNotConnectedError } from '../query/host-query-errors'
import { readViewBase } from '../query/host-read-client'
import { automationListRead } from './automation-operations'
import { automationOutcomeUnknownMessage, automationErrorMessage } from './automation-error'
import type { MobileAutomationRow } from './automation-reply-schema'

type AutomationCatalog = {
  rows: MobileAutomationRow[]
  capabilities: readonly string[]
  // The connection the rows were read on.
  epoch: string
}

const NO_INPUT = {}
// The paired desktop's list carries its SSH-owned automations too.
const PAIRED_TARGET: HostQueryTarget = { exec: 'local' }
// Server automation events are not relayed to phones yet (D16), so a visible server list polls.
const SERVER_POLL_MS = 15_000

async function readAutomationCatalog(client: RpcClient): Promise<AutomationCatalog> {
  const [rows, host] = await Promise.all([
    automationListRead.request(client, {}).then(automationListRead.interpret),
    readHostStatusReply(client).then(hostStatusProbe.interpret)
  ])
  return {
    rows,
    capabilities: host.accepted ? (host.value.capabilities ?? []) : [],
    epoch: hostConnectionEpoch(readViewBase(client))
  }
}

const automationCatalogQuery = defineHostQuery<typeof NO_INPUT, AutomationCatalog>({
  family: 'automation.list',
  fetch: (client) => readAutomationCatalog(client),
  // Mounts revalidate: events missed while no screen held the router never marked it stale.
  staleTime: 0,
  gcTime: 30 * 60_000,
  // A hidden page only marks the list stale on change events; coming back reads it.
  refetchOnWindowFocus: true,
  signal: { events: ['automationsChanged'] }
})

const serverAutomationCatalogQuery = defineHostQuery<typeof NO_INPUT, AutomationCatalog>({
  ...automationCatalogQuery,
  signal: undefined
})

export function useAutomationCatalog(
  hostId: string,
  client: RpcClient | null,
  executionHost?: ExecutionHostId
) {
  const queryClient = useQueryClient()
  const server = executionHost !== undefined
  const queryKey = useMemo(
    () =>
      hostQueryKey(
        hostId,
        automationCatalogQuery.family,
        executionHost ? { exec: executionHost } : PAIRED_TARGET,
        NO_INPUT
      ),
    [hostId, executionHost]
  )
  useHostEventRouter(hostId, server ? null : client)
  const catalog = useHostQuery(
    server ? serverAutomationCatalogQuery : automationCatalogQuery,
    { hostId, client },
    queryKey[3],
    NO_INPUT,
    { refetchInterval: server ? SERVER_POLL_MS : false }
  )
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(client?.getState() === 'connected')
  const latestClient = useRef(client)
  useLayoutEffect(() => {
    latestClient.current = client
  }, [client])
  const epoch = useRef(0)
  const warningAuthority = useRef(0)
  const setActionWarning = useCallback((value: SetStateAction<string | null>) => {
    warningAuthority.current++
    setActionError(value)
  }, [])
  const locked = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    setConnected(client?.getState() === 'connected')
    const stopState = client?.onStateChange(() => {
      epoch.current++
      setConnected(client.getState() === 'connected')
    })
    return () => {
      mounted.current = false
      epoch.current++
      stopState?.()
    }
  }, [client])

  // A local patch keeps the read time, so it does not count as a new read (revision).
  const setRows = useCallback(
    (update: SetStateAction<MobileAutomationRow[]>) => {
      const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt
      queryClient.setQueryData<AutomationCatalog>(
        queryKey,
        (held) =>
          held && {
            ...held,
            rows: typeof update === 'function' ? update(held.rows) : update
          },
        { updatedAt }
      )
    },
    [queryClient, queryKey]
  )

  // An explicit refresh clears the action warning it was asked under once a fresh list lands.
  const refresh = useCallback(
    async (explicit = false): Promise<void> => {
      if (!client || client.getState() !== 'connected') {
        return
      }
      const warning = warningAuthority.current
      const startedAt = Date.now()
      await queryClient.refetchQueries({ queryKey, exact: true })
      const read = queryClient.getQueryState(queryKey)
      if (
        explicit &&
        mounted.current &&
        warning === warningAuthority.current &&
        read?.status === 'success' &&
        read.dataUpdatedAt >= startedAt
      ) {
        setActionWarning(null)
      }
    },
    [client, queryClient, queryKey, setActionWarning]
  )

  async function perform<T>(
    action: (port: RpcClient, current: () => boolean) => Promise<T>,
    accept: (value: T) => void
  ): Promise<void> {
    if (locked.current || !client || client.getState() !== 'connected') {
      return
    }
    locked.current = true
    setBusy(true)
    setActionWarning(null)
    const at = epoch.current
    const generation = client.getGeneration?.()
    const current = () =>
      mounted.current &&
      latestClient.current === client &&
      at === epoch.current &&
      generation === client.getGeneration?.()
    try {
      const value = await action(client, current)
      if (current()) {
        accept(value)
      } else if (mounted.current) {
        setActionWarning(automationOutcomeUnknownMessage())
      }
    } catch (failure) {
      if (mounted.current) {
        setActionWarning(
          current() ? automationErrorMessage(failure) : automationOutcomeUnknownMessage()
        )
      }
    } finally {
      locked.current = false
      // Replaces any list read sent before the write, which would land over the accepted rows.
      void queryClient.refetchQueries({ queryKey, exact: true })
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  // Reads while disconnected fail fast; the screen already says it is offline.
  const readError =
    catalog.error && !isHostNotConnectedError(catalog.error)
      ? automationErrorMessage(catalog.error)
      : null
  return {
    rows: catalog.data?.rows ?? NO_ROWS,
    setRows,
    capabilities: catalog.data?.capabilities ?? NO_CAPABILITIES,
    loaded: catalog.data !== undefined,
    error: actionError ?? readError,
    setError: setActionWarning,
    busy,
    connected,
    // Bumps on every list read, so run history re-reads alongside it.
    revision: catalog.dataUpdatedAt,
    isCurrentSnapshot: () => {
      const port = latestClient.current
      return (
        mounted.current &&
        port?.getState() === 'connected' &&
        queryClient.getQueryData<AutomationCatalog>(queryKey)?.epoch === hostConnectionEpoch(port)
      )
    },
    refresh,
    perform
  }
}

const NO_ROWS: MobileAutomationRow[] = []
const NO_CAPABILITIES: readonly string[] = []
