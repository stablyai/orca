import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { rpcClientForExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import {
  projectSessionInventorySchema,
  type ProjectSessionSnapshot
} from './mobile-project-navigation'
import type { HostScreenController } from './use-host-screen-controller'

const inventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs.project-navigation',
    method: 'session.tabs.listAll',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('project-session-inventory', projectSessionInventorySchema)
  })
)

export function projectSnapshotKey(host: string | undefined, worktree: string) {
  return JSON.stringify([host ?? 'local', worktree])
}

export function useMobileProjectSessions(controller: HostScreenController) {
  const { client, connState, hostId, hostCapabilities, displayWorktrees, catalog } = controller
  const [inventory, setInventory] = useState<{
    client: typeof client
    hostId: typeof hostId
    generation: number
    snapshots: Map<string, ProjectSessionSnapshot>
  } | null>(null)
  const [tabRevision, setTabRevision] = useState(0)
  const generation = client?.getGeneration?.() ?? 0
  const hosts = [...new Set(displayWorktrees.map((w) => w.hostId ?? 'local'))].sort().join('|')
  const worktreeKeys = displayWorktrees
    .map((w) => projectSnapshotKey(w.hostId, w.worktreeId))
    .sort()
    .join('\n')
  const agentInventoryKey = displayWorktrees
    .flatMap((w) =>
      (w.agents ?? []).map(
        (a) => `${w.hostId ?? 'local'}:${w.worktreeId}:${a.paneKey}:${a.displayName ?? ''}`
      )
    )
    .sort()
    .join('\n')
  useEffect(() => {
    if (!client || connState !== 'connected' || typeof client.subscribe !== 'function') {
      return
    }
    const unsubscribes = hosts
      .split('|')
      .filter(Boolean)
      .flatMap((host) => {
        const scoped = rpcClientForExecutionHost(
          client,
          hostCapabilities,
          host === 'local' ? undefined : (host as ExecutionHostId)
        )
        return scoped
          ? [scoped.subscribe('session.tabs.subscribeAll', {}, () => setTabRevision((n) => n + 1))]
          : []
      })
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [client, connState, hostCapabilities, hosts, generation])
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let cancelled = false
    const currentHostByKey = new Map<string, string>()
    for (const key of worktreeKeys.split('\n').filter(Boolean)) {
      const [keyHost] = JSON.parse(key) as [string, string]
      currentHostByKey.set(key, keyHost)
    }
    void Promise.all(
      hosts
        .split('|')
        .filter(Boolean)
        .map(
          async (host): Promise<{ host: string; snapshots: ProjectSessionSnapshot[] | null }> => {
            const scoped = rpcClientForExecutionHost(
              client,
              hostCapabilities,
              host === 'local' ? undefined : (host as ExecutionHostId)
            )
            if (!scoped) {
              return { host, snapshots: null }
            }
            try {
              const reply = await inventoryRead.request(scoped)
              const result = inventoryRead.interpret(reply)
              return { host, snapshots: result.accepted ? result.value.snapshots : null }
            } catch {
              return { host, snapshots: null }
            }
          }
        )
    ).then((results) => {
      if (cancelled || (client.getGeneration?.() ?? 0) !== generation) {
        return
      }
      const failedHosts = new Set(results.filter((r) => r.snapshots === null).map((r) => r.host))
      setInventory((previous) => {
        const snapshots = new Map<string, ProjectSessionSnapshot>()
        if (
          previous?.client === client &&
          previous.hostId === hostId &&
          previous.generation === generation
        ) {
          for (const [key, snapshot] of previous.snapshots) {
            if (failedHosts.has(currentHostByKey.get(key) ?? '')) {
              snapshots.set(key, snapshot)
            }
          }
        }
        for (const result of results) {
          if (result.snapshots === null) {
            continue
          }
          for (const snapshot of result.snapshots) {
            const key = projectSnapshotKey(result.host, snapshot.worktree)
            if (currentHostByKey.has(key)) {
              snapshots.set(key, snapshot)
            }
          }
        }
        return { client, hostId, generation, snapshots }
      })
    })
    return () => {
      cancelled = true
    }
  }, [
    client,
    connState,
    hostId,
    hostCapabilities,
    hosts,
    worktreeKeys,
    agentInventoryKey,
    generation,
    catalog.refreshing,
    tabRevision
  ])
  return inventory?.client === client &&
    inventory.hostId === hostId &&
    inventory.generation === generation
    ? inventory.snapshots
    : new Map<string, ProjectSessionSnapshot>()
}
