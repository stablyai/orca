import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getPtyIpc } from '../pty-host-bindings'
import { inspectPtyProviderProcessForRenderer } from '../../../providers/pty/process-inspection'
import { clientOnlyUnverifiableInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import {
  getProviderForPty,
  hasPtyProviderForInspection,
  isDispatchablePtyHost,
  resolvePtyExecutionHost,
  tryGetProviderForPty,
  type ResolvedPtyHost
} from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { parsePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import {
  beforeDeadline,
  DEADLINE_PASSED,
  monotonicNow
} from '../../../../shared/concurrency/deadline-settle-notifier'
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
  const runningWorkChecks = new Map<string, { controller: AbortController; requests: number }>()
  ipcMain.removeAllListeners('pty:cancelRunningWorkCheck')
  ipcMain.on('pty:cancelRunningWorkCheck', (event, checkId: unknown) => {
    if (typeof checkId === 'string') {
      runningWorkChecks.get(`${event.sender.id}:${checkId}`)?.controller.abort()
    }
  })

  // Await daemon ownership handoff for local IDs; renderer-kill inlines this to preserve same-turn teardown without a barrier.
  const awaitSwapWindow = async (id: string): Promise<void> => {
    await getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(id))
  }

  installPtySessionListingIpcHandler(deps)

  // Await the local provider only when a local id is present; validation drops empty, oversized and repeated ids.
  const readInspectablePtyIds = async (args: { ids?: unknown }): Promise<string[]> => {
    const ids = new Set<string>()
    for (const value of Array.isArray(args?.ids) ? args.ids.slice(0, 512) : []) {
      if (typeof value === 'string' && value.length > 0 && value.length <= 512) {
        ids.add(value)
      }
    }
    if ([...ids].some((id) => resolvePtyExecutionHost(id) === LOCAL_EXECUTION_HOST_ID)) {
      await getLocalPtyProviderStartupPromise()
    }
    return [...ids]
  }

  ipcMain.handle(
    'pty:getAuthoritativeBufferSnapshotCapabilities',
    async (_event, args: { ids?: unknown }) =>
      (await readInspectablePtyIds(args)).map((id) => {
        const provider = tryGetProviderForPty(id)
        // Missing inspection support is non-authoritative; unattached SSH relays remain retryable.
        return {
          id,
          authoritative: !provider
            ? isDispatchablePtyHost(resolvePtyExecutionHost(id))
              ? null
              : false
            : provider.canProvideAuthoritativeBufferSnapshot
              ? provider.canProvideAuthoritativeBufferSnapshot(id)
              : false
        }
      })
  )

  ipcMain.removeHandler('pty:getGoneSessionIds')
  // Only a local provider's explicit absent answer marks a session gone; SSH and remote hosts keep their own parking rules.
  ipcMain.handle('pty:getGoneSessionIds', async (_event, args: { ids?: unknown }) => {
    // Bare legacy ids resolve local by fallback and may be old SSH panes; only daemon-minted ids qualify.
    const ids = (await readInspectablePtyIds(args)).filter(
      (id) =>
        resolvePtyExecutionHost(id) === LOCAL_EXECUTION_HOST_ID &&
        parsePtySessionId(id).worktreeId !== null
    )
    // Bounded so a large restore cannot flood the daemon socket during reconnect.
    const gone = await mapWithConcurrency(ids, 8, async (id) => {
      const provider = tryGetProviderForPty(id)
      if (!provider?.probePtyLiveness || provider.canProvideAuthoritativeBufferSnapshot?.(id)) {
        return false
      }
      try {
        return (await provider.probePtyLiveness(id)) === false
      } catch {
        return false
      }
    })
    return ids.filter((_id, index) => gone[index])
  })

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
      event,
      args: {
        id: string
        expectedIncarnationId?: string
        scanChildProcesses?: boolean
        runningWorkSinceMs?: number
        runningWorkCheckId?: string
        steadyState?: boolean
        jobMembershipOnly?: boolean
      }
    ) => {
      // Another host's PTY remains unverifiable here.
      if (typeof args?.id !== 'string' || !args.id || isRemoteRuntimePtyId(args.id)) {
        return clientOnlyUnverifiableInspection('terminal_gone')
      }
      const options = {
        ...(args.expectedIncarnationId
          ? { expectedIncarnationId: args.expectedIncarnationId }
          : {}),
        ...(args.scanChildProcesses === true ? { scanChildProcesses: true } : {}),
        ...(args.expectedIncarnationId &&
        typeof args.runningWorkSinceMs === 'number' &&
        Number.isSafeInteger(args.runningWorkSinceMs) &&
        resolvePtyExecutionHost(args.id) === LOCAL_EXECUTION_HOST_ID
          ? { runningWorkSinceMs: args.runningWorkSinceMs }
          : {}),
        ...(args.steadyState === true ? { steadyState: true } : {}),
        ...(args.jobMembershipOnly === true ? { jobMembershipOnly: true } : {})
      }
      const inspection = async (signal?: AbortSignal) => {
        // Restored terminals need the provider that owns their daemon.
        const startup = waitForPromiseWithSignal(awaitSwapWindow(args.id), signal)
        if (options.runningWorkSinceMs === undefined) {
          await startup
        } else if ((await beforeDeadline(startup, monotonicNow() + 750)) === DEADLINE_PASSED) {
          return clientOnlyUnverifiableInspection('timeout')
        }
        if (!hasPtyProviderForInspection(args.id)) {
          return clientOnlyUnverifiableInspection('terminal_gone')
        }
        const provider = getProviderForPty(args.id)
        return Object.keys(options).length > 0
          ? inspectPtyProviderProcessForRenderer(provider, args.id, { ...options, signal })
          : inspectPtyProviderProcessForRenderer(provider, args.id)
      }
      if (options.runningWorkSinceMs === undefined || !args.runningWorkCheckId) {
        return inspection()
      }
      const key = `${event.sender.id}:${args.runningWorkCheckId}`
      const batch = runningWorkChecks.get(key) ?? { controller: new AbortController(), requests: 0 }
      runningWorkChecks.set(key, batch)
      batch.requests += 1
      const signal = batch.controller.signal
      try {
        return await waitForPromiseWithSignal(inspection(signal), signal)
      } catch (error) {
        if (!signal.aborted) {
          throw error
        }
        return clientOnlyUnverifiableInspection('timeout')
      } finally {
        if (--batch.requests === 0) {
          runningWorkChecks.delete(key)
        }
      }
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
