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

  // Why: wait for daemon startup before selecting the local provider for an id
  // the swap may re-own (#7742); ids owned by an SSH connection never wait.
  // renderer-kill.ts inlines this — pty:kill's listener teardown is
  // ordering-sensitive and must not gain even a no-barrier microtask.
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
        // Resolved providers without the optional method, and hosts no provider here can serve, are
        // definitively non-authoritative; an unattached SSH relay remains retryable.
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
      // Why before the swap wait: a runtime terminal handle runs on another host, so only
      // "unverifiable" is honest and the local daemon startup is irrelevant to it.
      return null
    }
    // Why: the pre-swap LocalPtyProvider does not own restored daemon ids, and
    // its "no PTY" is exactly the false the renderer reconciler is allowed to
    // close panes on.
    await awaitSwapWindow(args.id)
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty) {
      return null
    }
    try {
      if (provider.hasPty(args.id)) {
        return true
      }
      // Why: hasPty only knows sessions attached this run, so a session that survived a restart reads absent until the host answers.
      return provider.probePtyLiveness ? await provider.probePtyLiveness(args.id) : false
    } catch {
      // Why: liveness is only allowed to close panes on an authoritative false.
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
      // Why: as pty:hasPty — another host's PTY reads as client-only unverifiable, not a raised IPC error.
      if (typeof args?.id !== 'string' || !args.id || isRemoteRuntimePtyId(args.id)) {
        return clientOnlyUnverifiableInspection('terminal_gone')
      }
      // Why: the pre-swap LocalPtyProvider does not own restored daemon ids, so
      // nothing it reports about one is an observation; the post-swap owner must
      // answer completion-sensitive inspection.
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
      // Why: the cached foreground API would turn stale process identity into shell/agent authority at a command boundary.
      return provider.confirmForegroundProcess?.(args.id) ?? null
    }
  )

  // Why: Cmd+D split needs the live shell cwd so the new pane inherits it (not the worktree root); '' means unknown/unresolvable (Windows) → renderer falls through.
  ipcMain.handle('pty:getCwd', async (_event, args: { id: string }): Promise<string> => {
    try {
      return await getProviderForPty(args?.id).getCwd(args.id)
    } catch {
      return ''
    }
  })

  // Why: prefer the provider's APPLIED size over the requested ptySizes so the renderer's resume drift-check can spot a dropped resize; null means "cannot confirm" → re-forward once.
  ipcMain.handle(
    'pty:getSize',
    async (_event, args: { id: string }): Promise<{ cols: number; rows: number } | null> => {
      const provider = tryGetProviderForPty(args?.id)
      try {
        if (provider?.getAppliedSize) {
          // Why: a provider-owned null means it could not verify the applied
          // grid; preserve null so the renderer re-forwards instead of trusting
          // the requested-size cache that may describe a dropped resize.
          return await provider.getAppliedSize(args.id)
        }
      } catch {
        // Fall through to the requested-size cache so a dead daemon/relay can't throw across the IPC boundary.
      }
      return ptySizes.get(args?.id) ?? null
    }
  )

  // Pre-signal handshake handlers (declare→spawn→settle/clear); see docs/mobile-prefer-renderer-scrollback.md and `pendingByPaneKey` above.
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
      // Why: the generation-to-PTY binding survives late teardown of a reused id; paneKey reverse maps may already be gone.
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
      // Why: remote-runtime panes skip the local spawn cooperation gate, so their exact PTY id is the only readiness key.
      rendererSerializerReadiness.markReady(args.ptyId)
    }
  )
}
