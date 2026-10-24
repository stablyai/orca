import { RECONCILIATION_INTERVAL_MS } from './mobile-session-reconciliation-cadence'
import { executionHostScopedClients } from '../transport/execution-host-scoped-rpc-client'
import {
  terminalInterfaceSnapshotSchema,
  type TerminalInterfaceObservation
} from '../../../src/shared/terminal-interface-observation'
import { worktreeIdsEqual } from '../../../src/shared/worktree/id'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { RpcClient } from '../transport/rpc-client'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../src/shared/runtime-mobile-session-tab-contracts'

const replicas = new WeakMap<RpcClient, ReturnType<typeof createReplica>>()
const empty = new Map<string, TerminalInterfaceObservation>()
function createReplica(client: RpcClient) {
  let observations = empty
  let version: { epoch: string; revision: number } | null = null
  const retired = new Set<string>()
  const listeners = new Set<() => void>()
  let stopFeed: (() => void) | undefined
  let stopState: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let subscription = 0
  let generation = client.getGeneration?.() ?? 0
  let unsupportedGeneration: number | null = null
  let disposed = false
  const publish = (next = empty) => {
    observations = next
    for (const listener of listeners) {
      listener()
    }
  }
  const retire = () => {
    subscription += 1
    stopFeed?.()
    stopFeed = undefined
    version = null
    retired.clear()
    publish()
  }
  const connect = () => {
    const nextGeneration = client.getGeneration?.() ?? 0
    if (stopFeed || unsupportedGeneration === nextGeneration || client.getState() !== 'connected') {
      return
    }
    generation = nextGeneration
    const current = ++subscription
    const stop = client.subscribe('runtime.clientEvents.subscribe', null, (value) => {
      if (current !== subscription || client.getState() !== 'connected') {
        return
      }
      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        (value.type === 'end' || value.type === 'error' || value.type === 'close')
      ) {
        if (
          'error' in value &&
          value.error &&
          typeof value.error === 'object' &&
          'code' in value.error &&
          (value.error.code === 'unsupported' || value.error.code === 'method_not_found')
        ) {
          unsupportedGeneration = generation
        }
        retire()
        return
      }
      const parsed = terminalInterfaceSnapshotSchema.safeParse(value)
      if (!parsed.success) {
        return
      }
      const frame = parsed.data
      if (
        retired.has(frame.epoch) ||
        (version?.epoch === frame.epoch && version.revision >= frame.revision)
      ) {
        return
      }
      if (version && version.epoch !== frame.epoch) {
        retired.add(version.epoch)
      }
      version = frame
      publish(
        new Map(
          frame.observations
            .filter((row) => row.epoch === frame.epoch)
            .map((row) => [row.terminalHandle, row])
        )
      )
    })
    if (current === subscription) {
      stopFeed = stop
    } else {
      stop()
    }
  }
  const stop = () => {
    clearInterval(timer)
    timer = undefined
    stopState?.()
    stopState = undefined
    unsupportedGeneration = null
    retire()
  }
  return {
    read: () => observations,
    subscribe(listener: () => void) {
      if (disposed) {
        return () => {}
      }
      listeners.add(listener)
      if (listeners.size === 1) {
        stopState = client.onStateChange((state) => {
          if (state !== 'connected' || generation !== (client.getGeneration?.() ?? 0)) {
            retire()
          }
        })
        timer = setInterval(connect, RECONCILIATION_INTERVAL_MS)
        connect()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop()
        }
      }
    },
    dispose() {
      disposed = true
      stop()
      listeners.clear()
    }
  }
}
export function mobileTerminalInterfaceReplica(client: RpcClient) {
  let replica = replicas.get(client)
  if (!replica) {
    replica = createReplica(client)
    replicas.set(client, replica)
  }
  return replica
}
export function disposeMobileTerminalInterfaceReplica(client: RpcClient) {
  for (const view of executionHostScopedClients(client)) {
    disposeMobileTerminalInterfaceReplica(view)
  }
  replicas.get(client)?.dispose()
  replicas.delete(client)
}
export function deriveMobileTerminalInterfaces<
  Tab extends { type: string; terminalInterface?: TerminalInterfaceObservation } & Partial<
    Omit<RuntimeMobileSessionTerminalClientTab, 'type'>
  >
>(
  tabs: Tab[],
  observations: ReadonlyMap<string, TerminalInterfaceObservation>,
  worktreeId: string
): ({
  [Key in keyof Tab as Exclude<Key, 'terminalInterface'>]: Tab[Key]
} & { terminalInterface?: TerminalInterfaceObservation })[] {
  return tabs.map((tab) => {
    if (tab.type !== 'terminal') {
      return tab
    }
    const observation = tab.terminal ? observations.get(tab.terminal) : undefined
    const pane = observation && parsePaneKey(observation.paneKey)
    const terminalInterface =
      observation &&
      observation.incarnationId === tab.incarnationId &&
      worktreeIdsEqual(observation.worktreeId, worktreeId) &&
      pane &&
      (!tab.parentTabId || tab.parentTabId === pane.tabId) &&
      (!tab.leafId || tab.leafId === pane.leafId)
        ? observation
        : undefined
    return { ...tab, terminalInterface }
  })
}
