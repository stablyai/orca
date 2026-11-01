import { getConnectionExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { layoutContainsLeafId } from '../persistence/restoring-sessions/terminal-layout-normalization'
import { ptyBindingIsRefused } from '../persistence/loading-store/pty-binding-refusals'
import { applyPtyBinding } from '../persistence/loading-store/pty-binding-session-update'
import { PaneOwnerContentionError } from '../ipc/pty/pane/pane-spawn-operation'
import { asProfileSessionStore, storeOf } from './profile-session-store.test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

type SpawnArgs = Parameters<NonNullable<RuntimePtyController['spawn']>>[0]

/** A fake controller replaces only the pane admitted for this spawn, like the lower owner. */
export function captureFakeSpawnBinding(
  runtime: OrcaRuntimeService,
  args: Pick<
    SpawnArgs,
    'worktreeId' | 'tabId' | 'leafId' | 'connectionId' | 'expectedSourceBinding'
  >,
  explicitHostId?: ExecutionHostId
): (result: unknown) => void {
  const store = storeOf(runtime)
  if (!store || !args.worktreeId || !args.tabId || !args.leafId) {
    return () => {}
  }
  const { worktreeId, tabId, leafId } = args
  const holdsPane = (hostId: ExecutionHostId): boolean => {
    const session = store.getWorkspaceSession?.(hostId)
    return (
      (session?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) ?? false) &&
      layoutContainsLeafId(session?.terminalLayoutsByTabId[tabId]?.root ?? null, leafId)
    )
  }
  const admitted = Reflect.has(store, 'admitTerminalPane')
  const hostId =
    explicitHostId ??
    (admitted
      ? [getConnectionExecutionHostId(args.connectionId), 'local' as const].find(holdsPane)
      : 'local')
  if (!hostId) {
    return () => {}
  }
  const sessions = asProfileSessionStore(store, hostId)
  const before = sessions.get(hostId)
  const paneKey = `${tabId}:${leafId}`
  const predecessor = before.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  const predecessorStamp = before.terminalPtyIncarnationsByPaneKey?.[paneKey]
  return (result) => {
    if (
      !result ||
      typeof result !== 'object' ||
      !('id' in result) ||
      typeof result.id !== 'string'
    ) {
      return
    }
    const incarnationId =
      'incarnationId' in result && typeof result.incarnationId === 'string'
        ? result.incarnationId
        : undefined
    try {
      runtime.assertPtyRegistrationAllowed(result.id, incarnationId)
    } catch (error) {
      runtime.releaseRejectedPtyRegistrationFence(result.id, incarnationId)
      throw error
    }
    const current = sessions.get(hostId)
    const bound = current.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
    const stamp = current.terminalPtyIncarnationsByPaneKey?.[paneKey]
    // Explicit committingSpawn and the common controller wrapper may observe the same commit.
    if (bound === result.id && stamp === incarnationId) {
      return
    }
    const binding = {
      worktreeId,
      tabId,
      leafId,
      ptyId: result.id,
      ...(incarnationId ? { incarnationId } : { dropsIncarnation: true as const }),
      ...(predecessor
        ? { expectedBinding: { ptyId: predecessor, incarnationId: predecessorStamp } }
        : {}),
      ...(args.expectedSourceBinding ? { expectedSourceBinding: args.expectedSourceBinding } : {}),
      mayCreate: !admitted,
      mayReviveRetiredSurface: false
    }
    if (
      (!predecessor && bound !== undefined) ||
      ptyBindingIsRefused(
        binding,
        current,
        worktreeId,
        paneKey,
        (store.getWorkspaceSessionHostIds?.() ?? [hostId]).map((hostId) => ({
          hostId,
          session: sessions.get(hostId)
        }))
      )
    ) {
      // The fake lower owner discards its refused child before returning, as the real provider does.
      try {
        runtime['ptyController']?.kill(result.id)
      } catch {
        // Cleanup cannot replace the original binding refusal.
      }
      throw args.expectedSourceBinding
        ? new Error('terminal_split_source_not_found')
        : new PaneOwnerContentionError()
    }
    applyPtyBinding(binding, current, worktreeId, paneKey)
    sessions.set(current, hostId)
  }
}
