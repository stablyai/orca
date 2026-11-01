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
import {
  loadMobileStructuredChatLaunchContext,
  withMobileStructuredChatLaunch
} from './mobile-structured-chat-launch'

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
  const {
    client,
    connState,
    hostCapabilities,
    hostId,
    worktreeId,
    open,
    setLoadState,
    setOptions
  } = args
  const hostRefusesOtherRuntime = hostRefusesOtherRuntimeWorkspace(args.hostCapabilities)
  // Include execution host because relayed servers can share workspace ids.
  const workspaceKey = composeWorktreeHostIdentity(useWorkspaceExecutionHost(), worktreeId)
  const observedTargetsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!open || !client || connState !== 'connected') {
      setLoadState('idle')
      setOptions([])
      return
    }

    let stale = false
    const cachedInventory = getCachedNewTabAgentInventory(hostId, workspaceKey)
    const cached = cachedInventory
      ? {
          ...cachedInventory,
          options: cachedInventory.options.map(({ agent, label }) => ({
            agent,
            label
          }))
        }
      : null
    // Mirror the desktop detection rule locally because its hook depends on the desktop store.
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
      const launchContext = await loadMobileStructuredChatLaunchContext({
        client,
        hostCapabilities
      }).catch(() => null)
      if (stale) {
        return
      }
      const options = withMobileStructuredChatLaunch(inventory.options, launchContext)
      const snapshotUnproven = hostCapabilities == null || hostCapabilities.length === 0
      // An empty gate list is not a host answer. Caching it would keep the hint off after status arrives.
      if (!snapshotUnproven || options.some((option) => option.opensAsChat)) {
        setCachedNewTabAgentInventory(hostId, workspaceKey, inventory)
      }
      setOptions(options)
      setLoadState('loaded')
    })().catch((error: unknown) => {
      if (stale) {
        return
      }
      const otherRuntime = error instanceof MobileWorkspaceOnOtherRuntimeError
      if (otherRuntime) {
        deleteCachedNewTabAgentInventory(hostId, workspaceKey)
      }
      // Failed refresh does not uninstall previously listed agents.
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
    hostCapabilities,
    hostId,
    hostRefusesOtherRuntime,
    open,
    setLoadState,
    setOptions,
    workspaceKey,
    worktreeId
  ])
}
