import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction
} from 'react'
import { AppState } from 'react-native'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { hostStatusProbe } from '../transport/host-status-probe-operations'
import { readHostStatusReply } from '../query/host-status-query'
import { subscribeConnectionRevival } from '../transport/connection-revival-signal'
import { subscribeSharedClientEvents } from '../transport/shared-client-events'
import { automationListRead } from './automation-operations'
import { automationOutcomeUnknownMessage, automationErrorMessage } from './automation-error'
import type { MobileAutomationRow } from './automation-reply-schema'

type CatalogBatch = {
  promise: Promise<void>
  finish: () => void
  warning?: number
}
type CatalogReadScope = {
  current: () => boolean
  pending: (CatalogBatch & { controller: AbortController }) | null
  trailing: CatalogBatch | null
}
function catalogBatch(warning?: number): CatalogBatch {
  let finish = () => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish, warning }
}

export function useAutomationCatalog(client: RpcClient | null, server: boolean) {
  const [rows, setRows] = useState<MobileAutomationRow[]>([])
  const [capabilities, setCapabilities] = useState<readonly string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(client?.getState() === 'connected')
  const [revision, setRevision] = useState(0)
  const latestClient = useRef(client)
  useLayoutEffect(() => {
    latestClient.current = client
  }, [client])
  const snapshotCurrent = useRef<() => boolean>(() => false)
  const epoch = useRef(0)
  const readScope = useRef<CatalogReadScope | null>(null)
  const warningAuthority = useRef(0)
  const setActionWarning = useCallback((value: SetStateAction<string | null>) => {
    warningAuthority.current++
    setActionError(value)
  }, [])
  const retireReads = useCallback(() => {
    const scope = readScope.current
    readScope.current = null
    snapshotCurrent.current = () => false
    scope?.pending?.finish()
    scope?.trailing?.finish()
    scope?.pending?.controller.abort()
  }, [])
  const locked = useRef(false)
  const mounted = useRef(false)
  const streamReady = useRef(false)

  const refresh = useCallback(
    (explicit = false, periodic = false): Promise<void> => {
      if (
        !mounted.current ||
        latestClient.current !== client ||
        !client ||
        client.getState() !== 'connected'
      ) {
        return Promise.resolve()
      }
      if (readScope.current && !readScope.current.current()) {
        retireReads()
      }
      if (!readScope.current) {
        const at = epoch.current
        const generation = client.getGeneration?.()
        const scope: CatalogReadScope = {
          current: () =>
            mounted.current &&
            latestClient.current === client &&
            at === epoch.current &&
            generation === client.getGeneration?.() &&
            readScope.current === scope,
          pending: null,
          trailing: null
        }
        readScope.current = scope
      }
      const scope = readScope.current
      const warning = explicit ? warningAuthority.current : undefined
      if (scope.pending) {
        if (periodic) {
          return scope.pending.promise
        }
        scope.trailing ??= catalogBatch(warning)
        if (explicit) {
          scope.trailing.warning = warning
        }
        return scope.trailing.promise
      }
      const run = async (batch: CatalogBatch): Promise<void> => {
        const controller = new AbortController()
        const pending = { ...batch, controller }
        scope.pending = pending
        const requests: Promise<RpcResponse>[] = []
        try {
          const listRequest = automationListRead.request(client, {}, { signal: controller.signal })
          requests.push(listRequest)
          const statusRequest = readHostStatusReply(client, { signal: controller.signal })
          requests.push(statusRequest)
          const [parsed, host] = await Promise.all([
            listRequest.then(automationListRead.interpret),
            statusRequest.then(hostStatusProbe.interpret)
          ])
          if (!scope.current()) {
            return
          }
          snapshotCurrent.current = scope.current
          setRows(parsed)
          setCapabilities(host.accepted ? (host.value.capabilities ?? []) : [])
          setLoaded(true)
          setRevision((value) => value + 1)
          setError(null)
          if (batch.warning !== undefined && batch.warning === warningAuthority.current) {
            setActionWarning(null)
          }
        } catch (failure) {
          controller.abort()
          await Promise.allSettled(requests)
          if (scope.current()) {
            setError(automationErrorMessage(failure))
          }
        } finally {
          batch.finish()
          if (scope.pending === pending) {
            scope.pending = null
            const trailing = scope.trailing
            scope.trailing = null
            if (trailing) {
              if (scope.current()) {
                void run(trailing)
              } else {
                trailing.finish()
              }
            }
          }
        }
      }
      const batch = catalogBatch(warning)
      void run(batch)
      return batch.promise
    },
    [client, retireReads, setActionWarning]
  )

  useEffect(() => {
    if (!client || server) {
      return
    }
    return subscribeSharedClientEvents(client, (event) => {
      if (event.type === 'end' || event.type === 'error') {
        streamReady.current = false
      }
      if (event.type === 'ready' || event.type === 'automationsChanged') {
        streamReady.current = true
        void refresh()
      }
    })
  }, [client, server, refresh])

  useEffect(() => {
    mounted.current = true
    setConnected(client?.getState() === 'connected')
    const stateChanged = () => {
      epoch.current++
      retireReads()
      streamReady.current = false
      setConnected(client?.getState() === 'connected')
      void refresh()
    }
    const stopState = client?.onStateChange(stateChanged)
    const stopRevival = subscribeConnectionRevival(() => void refresh())
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh()
      }
    })
    // Server automation events are not relayed; visible reads also recover an interrupted stream.
    const poll = setInterval(() => {
      if (AppState.currentState === 'active' && (server || !streamReady.current)) {
        void refresh(false, true)
      }
    }, 15000)
    void refresh()
    return () => {
      mounted.current = false
      epoch.current++
      retireReads()
      stopState?.()
      stopRevival()
      appState.remove()
      clearInterval(poll)
    }
  }, [client, server, refresh, retireReads])

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
        retireReads()
        accept(value)
      } else if (mounted.current) {
        setActionWarning(automationOutcomeUnknownMessage())
      }
    } catch (failure) {
      if (current()) {
        retireReads()
      }
      if (mounted.current) {
        setActionWarning(
          current() ? automationErrorMessage(failure) : automationOutcomeUnknownMessage()
        )
      }
    } finally {
      locked.current = false
      if (mounted.current) {
        setBusy(false)
        void refresh()
      }
    }
  }
  return {
    rows,
    setRows,
    capabilities,
    loaded,
    error: actionError ?? error,
    setError: setActionWarning,
    busy,
    connected,
    revision,
    isCurrentSnapshot: () => snapshotCurrent.current(),
    refresh,
    perform
  }
}
