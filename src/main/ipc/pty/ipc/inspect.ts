import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getPtyIpc } from '../../pty-host-bindings'
import { inspectPtyProviderProcessForRenderer } from '../../../providers/pty-process-inspection'
import { clientOnlyUnverifiableInspection } from '../../../../shared/terminal-process-inspection'
import {
  getProviderForPty,
  hasPtyProviderForInspection,
  isDispatchablePtyHost,
  resolvePtyExecutionHost,
  tryGetProviderForPty,
  type ResolvedPtyHost
} from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { installPtySessionListingIpcHandler } from './session-listing'
import { ptySizes } from '../delivery/visibility-state'
import { isValidPaneKey } from '../pane/key-state'
import {
  declarePendingPaneSerializer,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness,
  settlePendingPaneSerializer
} from '../pane/serializer-state'

export function installPtyInspectIpcHandlers(deps: {
  getLocalPtyProviderStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
}): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyProviderStartupPromise } = deps

  // Await daemon ownership handoff for local IDs; renderer-kill inlines this to preserve same-turn teardown without a barrier.
  const awaitSwapWindow = async (id: string): Promise<void> => {
    await getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(id))
  }

  installPtySessionListingIpcHandler(deps)

  ipcMain.handle(
    'pty:getAuthoritativeBufferSnapshotCapabilities',
    async (_event, args: { ids?: unknown }) => {
      const ids = Array.isArray(args?.ids) ? args.ids.slice(0, 512) : []
      const hasLocalPtyId = ids.some(
        (value) =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 512 &&
          resolvePtyExecutionHost(value) === LOCAL_EXECUTION_HOST_ID
      )
      if (hasLocalPtyId) {
        await getLocalPtyProviderStartupPromise()
      }
      const capabilities: { id: string; authoritative: boolean | null }[] = []
      const seen = new Set<string>()
      for (const value of ids) {
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > 512 ||
          seen.has(value)
        ) {
          continue
        }
        seen.add(value)
        const provider = tryGetProviderForPty(value)
        // Missing inspection support is non-authoritative; unattached SSH relays remain retryable.
        capabilities.push({
          id: value,
          authoritative: !provider
            ? isDispatchablePtyHost(resolvePtyExecutionHost(value))
              ? null
              : false
            : provider.canProvideAuthoritativeBufferSnapshot
              ? provider.canProvideAuthoritativeBufferSnapshot(value)
              : false
        })
      }
      return capabilities
    }
  )

  ipcMain.handle('pty:hasPty', async (_event, args: { id: string }): Promise<boolean | null> => {
    if (typeof args?.id !== 'string' || isRemoteRuntimePtyId(args.id)) {
      // Remote runtime handles need no local startup wait and cannot be inspected authoritatively here.
      return null
    }
    // Pre-swap local absence could falsely authorize the renderer to close restored panes.
    await awaitSwapWindow(args.id)
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty) {
      return null
    }
    try {
      if (provider.hasPty(args.id)) {
        return true
      }
      // hasPty sees only this run's attachments; probe the host for sessions surviving restart.
      return provider.probePtyLiveness ? await provider.probePtyLiveness(args.id) : false
    } catch {
      // Only authoritative false may close a pane.
      return null
    }
  })

  ipcMain.handle(
    'pty:hasChildProcesses',
    async (_event, args: { id: string }): Promise<boolean> => {
      if (typeof args?.id !== 'string' || !hasPtyProviderForInspection(args.id)) {
        return false
      }
      return getProviderForPty(args.id).hasChildProcesses(args.id)
    }
  )

  ipcMain.handle(
    'pty:getForegroundProcess',
    async (_event, args: { id: string }): Promise<string | null> => {
      if (typeof args?.id !== 'string' || !hasPtyProviderForInspection(args.id)) {
        return null
      }
      return getProviderForPty(args.id).getForegroundProcess(args.id)
    }
  )

  ipcMain.handle(
    'pty:inspectProcess',
    async (
      _event,
      args: {
        id: string
        expectedIncarnationId?: string
        scanChildProcesses?: boolean
        steadyState?: boolean
      }
    ) => {
      // Another host's PTY remains unverifiable here.
      if (typeof args?.id !== 'string' || !args.id || isRemoteRuntimePtyId(args.id)) {
        return clientOnlyUnverifiableInspection('terminal_gone')
      }
      // Completion-sensitive inspection must wait for the provider that owns restored daemon sessions.
      await awaitSwapWindow(args.id)
      if (!hasPtyProviderForInspection(args.id)) {
        return clientOnlyUnverifiableInspection('terminal_gone')
      }
      const options = {
        ...(args.expectedIncarnationId
          ? { expectedIncarnationId: args.expectedIncarnationId }
          : {}),
        ...(args.scanChildProcesses === true ? { scanChildProcesses: true } : {}),
        ...(args.steadyState === true ? { steadyState: true } : {})
      }
      return Object.keys(options).length > 0
        ? inspectPtyProviderProcessForRenderer(getProviderForPty(args.id), args.id, options)
        : inspectPtyProviderProcessForRenderer(getProviderForPty(args.id), args.id)
    }
  )

  ipcMain.handle(
    'pty:confirmForegroundProcess',
    async (_event, args: { id: string }): Promise<string | null> => {
      if (typeof args?.id !== 'string' || !hasPtyProviderForInspection(args.id)) {
        return null
      }
      const provider = getProviderForPty(args.id)
      // Cached foreground identity cannot authorize a command-boundary decision.
      return provider.confirmForegroundProcess?.(args.id) ?? null
    }
  )

  // Split panes inherit live shell cwd; empty means unknown and lets the renderer fall back.
  ipcMain.handle('pty:getCwd', async (_event, args: { id: string }): Promise<string> => {
    try {
      return await getProviderForPty(args?.id).getCwd(args.id)
    } catch {
      return ''
    }
  })

  // Report applied geometry so the renderer can detect and retry a dropped resize.
  ipcMain.handle(
    'pty:getSize',
    async (_event, args: { id: string }): Promise<{ cols: number; rows: number } | null> => {
      const provider = tryGetProviderForPty(args?.id)
      try {
        if (provider?.getAppliedSize) {
          // Provider-owned null preserves uncertainty; a requested-size cache may describe a dropped resize.
          return await provider.getAppliedSize(args.id)
        }
      } catch {
        // Provider failure must not escape IPC; retain requested size as a fallback.
      }
      return ptySizes.get(args?.id) ?? null
    }
  )

  // Predeclare serializer ownership before spawn; see docs/mobile-prefer-renderer-scrollback.md.
  ipcMain.handle(
    'pty:declarePendingPaneSerializer',
    async (event, args: { paneKey?: unknown }): Promise<number> => {
      if (!isValidPaneKey(args?.paneKey)) {
        throw new Error('Invalid paneKey')
      }
      return declarePendingPaneSerializer(args.paneKey, event?.sender)
    }
  )

  ipcMain.handle(
    'pty:settlePaneSerializer',
    async (_event, args: { paneKey?: unknown; gen?: unknown }): Promise<void> => {
      if (!isValidPaneKey(args?.paneKey) || typeof args.gen !== 'number') {
        return
      }
      const ptyId = pendingPtyIdBySerializerGeneration.get(args.gen)
      const settledCurrentGeneration = settlePendingPaneSerializer(args.paneKey, args.gen)
      // Keep generation-to-PTY binding through late teardown; reverse pane maps may already be gone.
      pendingPtyIdBySerializerGeneration.delete(args.gen)
      if (settledCurrentGeneration && ptyId) {
        rendererSerializerReadiness.markReady(ptyId)
      }
    }
  )

  ipcMain.handle(
    'pty:clearPendingPaneSerializer',
    async (_event, args: { paneKey?: unknown; gen?: unknown }): Promise<void> => {
      if (!isValidPaneKey(args?.paneKey) || typeof args.gen !== 'number') {
        return
      }
      settlePendingPaneSerializer(args.paneKey, args.gen)
      pendingPtyIdBySerializerGeneration.delete(args.gen)
    }
  )

  ipcMain.handle(
    'pty:reportRendererSerializerReady',
    async (_event, args: { ptyId?: unknown }): Promise<void> => {
      if (
        typeof args?.ptyId !== 'string' ||
        !isRemoteRuntimePtyId(args.ptyId) ||
        args.ptyId.length > 512
      ) {
        return
      }
      // Remote-runtime panes bypass local spawn coordination; readiness must use their exact PTY ID.
      rendererSerializerReadiness.markReady(args.ptyId)
    }
  )
}
