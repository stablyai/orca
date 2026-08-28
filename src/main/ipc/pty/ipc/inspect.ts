import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { inspectPtyProviderProcessForRenderer } from '../../../providers/pty-process-inspection'
import {
  PtyProcessListAdmission,
  visitPtyProcessListingsInBatches
} from '../../../providers/pty-process-list-admission'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import { ptyOwnership } from '../provider/ownership-state'
import {
  getProviderForPty,
  hasPtyProviderForInspection,
  registeredPtyProviders,
  sshProviders,
  tryGetProviderForPty
} from '../provider/registry'
import { ptySizes } from '../delivery/visibility-state'
import { isValidPaneKey } from '../pane/key-state'
import {
  declarePendingPaneSerializer,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness,
  settlePendingPaneSerializer
} from '../pane/serializer-state'

export function installPtyInspectIpcHandlers(deps: {
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
}): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyProviderStartupPromise } = deps

  ipcMain.handle('pty:listSessions', async (): Promise<PtyListedSession[]> => {
    const deduped = new Map<string, PtyListedSession>()
    const admission = new PtyProcessListAdmission()
    await visitPtyProcessListingsInBatches(
      registeredPtyProviders(),
      ({ provider, connectionId }) =>
        connectionId === null ? provider.listProcesses() : provider.listProcesses().catch(() => []),
      ({ provider, connectionId }, sessions) => {
        for (const rawSession of sessions) {
          const session = admission.admit(rawSession)
          // Why: kill actions only send back the PTY id, so rebuild ownership while listing to keep reconnect-discovered remote sessions routed to their provider.
          ptyOwnership.set(session.id, connectionId)
          deduped.set(session.id, {
            id: session.id,
            cwd: session.cwd,
            title: session.title,
            // Why: the renderer's binding map is empty during restore, so ownership is the only
            // liveness evidence it has. Absence is authoritative only from a provider that
            // serializes claims — otherwise it is 'unknown', never 'absent' (#8459).
            agentOwnership:
              (session.agentSessionOwners?.length ?? 0) > 0
                ? 'present'
                : provider.providesAgentSessionOwnerListings?.(session.id) === true
                  ? 'absent'
                  : 'unknown'
          })
        }
      }
    )
    return Array.from(deduped.values())
  })

  ipcMain.handle(
    'pty:getAuthoritativeBufferSnapshotCapabilities',
    async (_event, args: { ids?: unknown }) => {
      const ids = Array.isArray(args?.ids) ? args.ids.slice(0, 512) : []
      const hasLocalPtyId = ids.some((value) => {
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > 512 ||
          value.startsWith('remote:') ||
          parseAppSshPtyId(value)
        ) {
          return false
        }
        const ownedConnectionId = ptyOwnership.get(value)
        return ownedConnectionId === undefined || ownedConnectionId === null
      })
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
        // Resolved providers without the optional method are definitively non-authoritative; null remains retryable.
        capabilities.push({
          id: value,
          authoritative:
            provider === undefined || provider === null
              ? null
              : provider.canProvideAuthoritativeBufferSnapshot
                ? provider.canProvideAuthoritativeBufferSnapshot(value)
                : false
        })
      }
      return capabilities
    }
  )

  ipcMain.handle('pty:hasPty', async (_event, args: { id: string }): Promise<boolean | null> => {
    if (typeof args?.id !== 'string' || args.id.startsWith('remote:')) {
      // Why: same routing hazard pty:kill guards against — ptyOwnership never holds
      // a runtime terminal handle and parseAppSshPtyId ignores it, so the lookup
      // falls through to the local provider and its "not in my table" reads as an
      // authoritative dead. That is a fabricated answer about another host's PTY.
      return null
    }
    const ownedConnectionId = ptyOwnership.get(args.id)
    const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
    const provider = parsedSshId
      ? sshProviders.get(parsedSshId.connectionId)
      : tryGetProviderForPty(args.id)
    if (!provider?.hasPty) {
      return null
    }
    try {
      return provider.hasPty(args.id)
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

  ipcMain.handle('pty:inspectProcess', async (_event, args: { id: string }) => {
    // Why: same routing hazard as pty:hasPty — an unroutable id must read as unavailable, not as a local-provider answer or a raised IPC error.
    if (
      typeof args?.id !== 'string' ||
      !args.id ||
      args.id.startsWith('remote:') ||
      !hasPtyProviderForInspection(args.id)
    ) {
      return { foregroundProcess: null, hasChildProcesses: false, unavailable: true as const }
    }
    return inspectPtyProviderProcessForRenderer(getProviderForPty(args.id), args.id)
  })

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
        !args.ptyId.startsWith('remote:') ||
        args.ptyId.length > 512
      ) {
        return
      }
      // Why: remote-runtime panes skip the local spawn cooperation gate, so their exact PTY id is the only readiness key.
      rendererSerializerReadiness.markReady(args.ptyId)
    }
  )
}
