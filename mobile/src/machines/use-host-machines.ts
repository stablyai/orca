import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { MachineProviderKey } from '../../../src/shared/machine-inventory'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  machinesListRead,
  machineSleep,
  machineWake,
  type MobileMachineProvider
} from './machine-operations'
import { readMachineAction, readMachinesList } from './machine-replies'

// A poll re-reads the desktop's cache; only opening, returning to the app and a manual refresh ask
// providers, since a provider run can be a billed cloud call.
const MACHINES_POLL_MS = 60_000

export type HostMachinesState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  /** `fetchedAt` is this phone's clock; `error` set means the rows are from that older read. */
  | { status: 'ready'; providers: MobileMachineProvider[]; fetchedAt: number; error: string | null }
  | { status: 'failed'; error: string }

export type HostMachinesNotice = { title: string; message: string }
export type MachineVerb = 'wake' | 'sleep'
type ProviderRefresh = 'ask-providers' | 'cached'

const LOST_CONTACT = 'Lost contact with this computer; checking what happened…'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useHostMachines(args: {
  client: RpcClient | null
  connState: ConnectionState
  focused: boolean
  now?: () => number
}): {
  state: HostMachinesState
  refreshing: boolean
  busy: { machineId: string; verb: MachineVerb } | null
  notice: HostMachinesNotice | null
  dismissNotice: () => void
  refresh: () => Promise<void>
  act: (providerKey: MachineProviderKey, machineId: string, verb: MachineVerb) => Promise<void>
} {
  const { client, connState, focused } = args
  // A ref, so a caller's inline clock never re-runs the effects below.
  const nowRef = useRef(args.now ?? Date.now)
  nowRef.current = args.now ?? Date.now
  const [state, setState] = useState<HostMachinesState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<{ machineId: string; verb: MachineVerb } | null>(null)
  const [notice, setNotice] = useState<HostMachinesNotice | null>(null)
  const generation = useRef(0)

  const keepRowsOr = useCallback((error: string) => {
    // A failed read keeps the rows the phone already shows, marked as from the older read.
    setState((previous) =>
      previous.status === 'ready' ? { ...previous, error } : { status: 'failed', error }
    )
  }, [])

  const load = useCallback(
    async (mode: ProviderRefresh) => {
      if (!client || connState !== 'connected') {
        return
      }
      const current = ++generation.current
      setRefreshing(true)
      try {
        const reply = await machinesListRead.request(client, {
          refresh: mode === 'ask-providers'
        })
        if (current !== generation.current) {
          return
        }
        const outcome = readMachinesList(reply)
        if (outcome.kind === 'providers') {
          setState({
            status: 'ready',
            providers: outcome.providers,
            fetchedAt: nowRef.current(),
            error: null
          })
        } else if (outcome.kind === 'unavailable') {
          setState({ status: 'unavailable' })
        } else {
          keepRowsOr(outcome.message)
        }
      } catch (error) {
        if (current === generation.current) {
          keepRowsOr(messageOf(error))
        }
      } finally {
        if (current === generation.current) {
          setRefreshing(false)
        }
      }
    },
    [client, connState, keepRowsOr]
  )

  useEffect(() => {
    if (!focused) {
      return
    }
    void load('ask-providers')
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') {
        void load('cached')
      }
    }, MACHINES_POLL_MS)
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void load('ask-providers')
      }
    })
    return () => {
      clearInterval(interval)
      appState.remove()
    }
  }, [focused, load])

  const act = useCallback(
    async (providerKey: MachineProviderKey, machineId: string, verb: MachineVerb) => {
      if (!client) {
        return
      }
      setBusy({ machineId, verb })
      try {
        const operation = verb === 'wake' ? machineWake : machineSleep
        let outcome: ReturnType<typeof readMachineAction>
        try {
          outcome = readMachineAction(
            await operation.request(client, { providerKey, machineId }),
            verb
          )
        } catch {
          outcome = { kind: 'unverified' }
        }
        if (outcome.kind === 'failed') {
          setNotice({
            title: verb === 'wake' ? 'Could not wake machine' : 'Could not sleep machine',
            message: outcome.message
          })
        } else if (outcome.kind === 'unverified') {
          // The desktop may still be waking or sleeping it; the next list says which.
          setNotice({ title: 'Lost contact', message: LOST_CONTACT })
        }
        await load('ask-providers')
      } finally {
        setBusy(null)
      }
    },
    [client, load]
  )

  return {
    state,
    refreshing,
    busy,
    notice,
    dismissNotice: () => setNotice(null),
    refresh: () => load('ask-providers'),
    act
  }
}

/**
 * Whether the host screen should offer Machines: the desktop answers machines.list with at least
 * one provider. Re-read on every connection and when the app returns to the foreground, so turning
 * Machines on (or off) on the desktop shows up without leaving the screen.
 */
export function useHostMachinesAvailable(
  client: RpcClient | null,
  connState: ConnectionState
): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    setAvailable(false)
    if (!client || connState !== 'connected') {
      return
    }
    let stale = false
    const check = (): void => {
      void machinesListRead
        .request(client)
        .then((reply) => {
          if (!stale) {
            const outcome = readMachinesList(reply)
            setAvailable(outcome.kind === 'providers' && outcome.providers.length > 0)
          }
        })
        .catch(() => undefined)
    }
    check()
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        check()
      }
    })
    return () => {
      stale = true
      appState.remove()
    }
  }, [client, connState])
  return available
}
