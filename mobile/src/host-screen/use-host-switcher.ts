import { useCallback, useEffect, useRef, useState } from 'react'
import { switchHostRoute } from '../host-route-exit'
import { holdSessionLeave } from '../session/session-leave-guard'
import { useRpcClientContext } from '../transport/client-context'
import { loadHostCatalog } from '../transport/host-store'
import type { ConnectionState, HostProfile } from '../transport/types'
import { hostSwitcherHosts, hostSwitcherOptions } from './host-switcher-options'

type HostSwitcherRouter = Parameters<typeof switchHostRoute>[0]

export type HostSwitcher = ReturnType<typeof useHostSwitcher>

export function useHostSwitcher(currentHostId: string | undefined, router: HostSwitcherRouter) {
  const ctx = useRpcClientContext()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [visible, setVisible] = useState(false)
  const [loadKey, setLoadKey] = useState(0)
  const [states, setStates] = useState<Record<string, ConnectionState>>({})
  const pickedRef = useRef<string | null>(null)
  // Last list that loaded, and the newest load to wait for before trusting it.
  const knownHostsRef = useRef<HostProfile[]>([])
  const settledRef = useRef<Promise<void>>(Promise.resolve())
  // A waiting pick belongs to one open of one mounted switcher.
  const opensRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Load on mount for the trigger and again on each open, so a desktop paired or removed elsewhere shows up.
  useEffect(() => {
    let live = true
    settledRef.current = loadHostCatalog()
      .then(
        (catalog) => {
          if (live) {
            const next = hostSwitcherHosts(catalog)
            knownHostsRef.current = next
            ctx.primeHosts(next)
            setHosts(next)
          }
        },
        () => {}
      )
      .catch(() => {})
    return () => {
      live = false
    }
  }, [ctx, loadKey])

  useEffect(() => {
    if (!visible) {
      return
    }
    const known: Record<string, ConnectionState> = {}
    for (const host of hosts) {
      known[host.id] = ctx.getKnownState(host.id) ?? 'disconnected'
    }
    setStates(known)
    const unsubscribes = hosts.map((host) =>
      ctx.subscribeHostState(host.id, (state) =>
        setStates((previous) => ({ ...previous, [host.id]: state }))
      )
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [ctx, hosts, visible])

  const open = useCallback(() => {
    opensRef.current += 1
    pickedRef.current = null
    setLoadKey((key) => key + 1)
    setVisible(true)
  }, [])
  const close = useCallback(() => setVisible(false), [])

  // Resolves whether it switched. A pick may land while the reload on open is still running, so wait for it
  // and check against the newest list that loaded; a failed reload keeps the previous one.
  const onAfterClose = useCallback(async (): Promise<boolean> => {
    const picked = pickedRef.current
    pickedRef.current = null
    if (!picked || picked === currentHostId) {
      return false
    }
    const opening = opensRef.current
    await settledRef.current
    if (!mountedRef.current || opening !== opensRef.current) {
      return false
    }
    if (!knownHostsRef.current.some((host) => host.id === picked)) {
      return false
    }
    // Same hold as the Back button: an open session may keep the user here.
    if (holdSessionLeave()) {
      return false
    }
    switchHostRoute(router, picked)
    return true
  }, [currentHostId, router])

  return {
    // Count other desktops: the current one may itself have dropped out of the connectable list.
    canSwitch: currentHostId !== undefined && hosts.some((host) => host.id !== currentHostId),
    open,
    pickerProps: {
      visible,
      options: hostSwitcherOptions(hosts, (hostId) => states[hostId] ?? 'disconnected'),
      selected: currentHostId ?? '',
      onSelect: (hostId: string) => {
        pickedRef.current = hostId
      },
      onClose: close,
      onAfterClose
    }
  }
}
