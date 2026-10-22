import { useEffect, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import {
  deleteCachedNewTabAgentInventory,
  getCachedNewTabAgentInventory,
  setCachedNewTabAgentInventory
} from '../cache/new-tab-agent-inventory-cache'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileNewTabAgentOptions,
  MobileWorkspaceOnOtherRuntimeError
} from './mobile-new-tab-agent-loader'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { MobileNewTabAgentLoadState } from './mobile-session-route-types'

/** Loads the agents the New Tab drawer and the diff-notes picker offer while either is open. */
export function useMobileNewTabAgentOptions(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  hostCapabilities: readonly string[] | null | undefined
  worktreeId: string
  open: boolean
  setLoadState: (state: MobileNewTabAgentLoadState) => void
  setOptions: (options: MobileNewTabAgentOption[]) => void
}): void {
  const { client, connState, hostId, worktreeId, open, setLoadState, setOptions } = args
  const hostRefusesOtherRuntime = hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
  // Why the execution host: servers relayed by one paired desktop can share a workspace id.
  const workspaceKey = composeWorktreeHostIdentity(useWorkspaceExecutionHost(), worktreeId)
  const observedTargetsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!open || !client || connState !== 'connected') {
      setLoadState('idle')
      setOptions([])
      return
    }

    let stale = false
    const cached = getCachedNewTabAgentInventory(hostId, workspaceKey)
    // Why mirrored, not imported: useDetectedAgents' rule reads desktop's store. A screen reuses a
    // settled detection, and the first open on a new screen refreshes a known list or detects again.
    const observedTargets = observedTargetsRef.current
    const target = `${hostId}\u0000${workspaceKey}\u0000${hostRefusesOtherRuntime}`
    const observed = observedTargets.has(target)
    setLoadState(cached ? 'loaded' : 'loading')
    setOptions(cached?.options ?? [])

    void (async () => {
      const inventory = await loadMobileNewTabAgentOptions({
        client,
        worktreeId,
        hostRefusesOtherRuntime,
        settled: observed ? cached : null,
        refresh: !observed && Boolean(cached?.detectedAgents.length)
      })
      if (stale) {
        return
      }
      observedTargets.add(target)
      setCachedNewTabAgentInventory(hostId, workspaceKey, inventory)
      setOptions(inventory.options)
      setLoadState('loaded')
    })().catch((error: unknown) => {
      if (stale) {
        return
      }
      const otherRuntime = error instanceof MobileWorkspaceOnOtherRuntimeError
      if (otherRuntime) {
        deleteCachedNewTabAgentInventory(hostId, workspaceKey)
      }
      // Why keep the cached list otherwise: a failed refresh does not uninstall the agents it showed.
      if (otherRuntime || !cached) {
        setOptions([])
        setLoadState(otherRuntime ? 'other-runtime' : 'error')
      }
    })

    return () => {
      stale = true
    }
  }, [
    client,
    connState,
    hostId,
    hostRefusesOtherRuntime,
    open,
    setLoadState,
    setOptions,
    workspaceKey,
    worktreeId
  ])
}
