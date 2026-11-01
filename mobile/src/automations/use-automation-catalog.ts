import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { hostStatusProbe } from '../transport/host-status-probe-operations'
import { subscribeConnectionRevival } from '../transport/connection-revival-signal'
import { automationListRead } from './automation-operations'
import { automationOutcomeUnknownMessage, automationErrorMessage } from './automation-error'
import type { MobileAutomationRow } from './automation-reply-schema'

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
  const readId = useRef(0)
  const locked = useRef(false)
  const mounted = useRef(false)
  const streamReady = useRef(false)

  const refresh = useCallback(
    async (explicit = false) => {
      if (!client || client.getState() !== 'connected') {
        return
      }
      const id = ++readId.current
      const at = epoch.current
      const generation = client.getGeneration?.()
      const current = () =>
        mounted.current &&
        latestClient.current === client &&
        at === epoch.current &&
        generation === client.getGeneration?.() &&
        id === readId.current
      try {
        const [list, status] = await Promise.all([
          automationListRead.request(client, {}),
          hostStatusProbe.request(client)
        ])
        if (!current()) {
          return
        }
        const parsed = automationListRead.interpret(list)
        const host = hostStatusProbe.interpret(status)
        snapshotCurrent.current = () =>
          mounted.current &&
          latestClient.current === client &&
          at === epoch.current &&
          generation === client.getGeneration?.()
        setRows(parsed)
        setCapabilities(host.accepted ? (host.value.capabilities ?? []) : [])
        setLoaded(true)
        setRevision((value) => value + 1)
        setError(null)
        if (explicit) {
          setActionError(null)
        }
      } catch (failure) {
        if (current()) {
          setError(automationErrorMessage(failure))
        }
      }
    },
    [client]
  )

  useEffect(() => {
    if (!client || server) {
      return
    }
    const stopEvents = client.subscribe(
      'runtime.clientEvents.subscribe',
      null,
      (event: unknown) => {
        if (!event || typeof event !== 'object' || !('type' in event)) {
          return
        }
        if (event.type === 'end' || event.type === 'error') {
          streamReady.current = false
        }
        if (event.type === 'ready' || event.type === 'automationsChanged') {
          streamReady.current = true
          void refresh()
        }
      }
    )
    return stopEvents
  }, [client, server, refresh])

  useEffect(() => {
    mounted.current = true
    setConnected(client?.getState() === 'connected')
    const stateChanged = () => {
      epoch.current++
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
        void refresh()
      }
    }, 15000)
    void refresh()
    return () => {
      mounted.current = false
      epoch.current++
      stopState?.()
      stopRevival()
      appState.remove()
      clearInterval(poll)
    }
  }, [client, server, refresh])

  async function perform<T>(
    action: (port: RpcClient, current: () => boolean) => Promise<T>,
    accept: (value: T) => void
  ): Promise<void> {
    if (locked.current || !client || client.getState() !== 'connected') {
      return
    }
    locked.current = true
    setBusy(true)
    setActionError(null)
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
        setActionError(automationOutcomeUnknownMessage())
      }
    } catch (failure) {
      if (mounted.current) {
        setActionError(
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
    setError: setActionError,
    busy,
    connected,
    revision,
    isCurrentSnapshot: () => snapshotCurrent.current(),
    refresh,
    perform
  }
}
