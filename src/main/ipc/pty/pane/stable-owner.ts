import { persistFreshPaneBinding } from '../runtime/spawn-commit'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { retireTerminalSurfaceFromPersistence } from '../../../runtime/mobile-session-terminal-persistence-retirement'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'
import { getPtySshConnectionId } from '../provider/registry'
import { ptyIncarnationById } from '../provider/ownership-state'
import type { ReplacedPaneOwner } from './replaced-pane-owner'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'

export type StablePaneOwner = {
  handle?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  hasPersistedBinding?: true
  persistedIncarnationId?: string
  runtimeIncarnationId?: string
}
export type StablePaneAdoption = {
  result: PtySpawnResult
  owner: StablePaneOwner
  materialized?: true
} | null
export const stablePaneAdoptionsByOwnerKey = new Map<string, Promise<StablePaneAdoption>>()

export function resolvePersistedStablePaneOwner(
  store: Store | undefined,
  paneKey: string,
  worktreeId: string,
  connectionId: string | null | undefined
): Pick<StablePaneOwner, 'tabId' | 'leafId' | 'ptyId' | 'incarnationId'> | null {
  if (!store || typeof store.getWorkspaceSession !== 'function') {
    return null
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const session = store.getWorkspaceSession(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  const tab = session.tabsByWorktree?.[worktreeId]?.find(
    (candidate) => candidate.id === parsed.tabId && candidate.worktreeId === worktreeId
  )
  const ptyId = session.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
  if (!tab || typeof ptyId !== 'string' || ptyId.length === 0) {
    return null
  }
  const incarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  return {
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    ptyId,
    ...(incarnationId ? { incarnationId } : {})
  }
}

export function resolveStablePaneOwner(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  paneKey: string | null | undefined,
  worktreeId: string | undefined,
  connectionId: string | null | undefined
): StablePaneOwner | null {
  if (!paneKey || !worktreeId) {
    return null
  }
  let resolved: ReturnType<OrcaRuntimeService['resolveTerminalPane']> | null = null
  let resolvedHandleCandidate: ReturnType<OrcaRuntimeService['resolveTerminalPane']> | null = null
  if (runtime && typeof runtime.resolveTerminalPane === 'function') {
    try {
      const candidate = runtime.resolveTerminalPane(paneKey, worktreeId)
      resolvedHandleCandidate = candidate
      resolved = candidate.connected === false ? null : candidate
    } catch (error) {
      if (!(error instanceof Error && error.message === 'terminal_not_found')) {
        throw error
      }
    }
  }
  const persisted = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
  if (resolved?.ptyId && persisted && resolved.ptyId !== persisted.ptyId) {
    throw new Error('terminal_pane_owner_conflict')
  }
  const ptyId = resolved?.ptyId ?? persisted?.ptyId
  if (!ptyId) {
    return null
  }
  if (getPtySshConnectionId(ptyId) !== (connectionId ?? null)) {
    throw new Error('terminal_pane_owner_host_mismatch')
  }
  const runtimeIncarnationId = ptyIncarnationById.get(ptyId)
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  return {
    ...(resolvedHandleCandidate?.ptyId === ptyId ? { handle: resolvedHandleCandidate.handle } : {}),
    tabId: resolved?.tabId || persisted?.tabId || parsed.tabId,
    leafId: resolved?.leafId || persisted?.leafId || parsed.leafId,
    ptyId,
    ...(runtimeIncarnationId || persisted?.incarnationId
      ? { incarnationId: runtimeIncarnationId ?? persisted?.incarnationId }
      : {}),
    ...(persisted ? { hasPersistedBinding: true as const } : {}),
    ...(persisted?.incarnationId ? { persistedIncarnationId: persisted.incarnationId } : {}),
    ...(runtimeIncarnationId ? { runtimeIncarnationId } : {})
  }
}

export async function retirePersistedStablePaneOwner(
  store: Store | undefined,
  owner: StablePaneOwner,
  worktreeId: string,
  connectionId: string | null | undefined
): Promise<boolean> {
  if (!store) {
    return false
  }
  return store.runDurableMutation(() => {
    const paneKey = makePaneKey(owner.tabId, owner.leafId)
    const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
    const current = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
    if (!current) {
      // A renderer removal may still be waiting for its debounced write.
      return { value: true, persist: 'if-dirty' }
    }
    if (current.ptyId !== owner.ptyId || current.incarnationId !== owner.persistedIncarnationId) {
      return { value: false, persist: false }
    }
    const session = cloneWorkspaceSessionState(store.getWorkspaceSession(hostId))
    const retired = retireTerminalSurfaceFromPersistence(session, {
      worktreeId,
      parentTabId: owner.tabId,
      leafId: owner.leafId,
      ptyId: owner.ptyId,
      ...(current.incarnationId ? { incarnationId: current.incarnationId } : {})
    })
    if (retired === session) {
      return { value: false, persist: false }
    }
    store.setWorkspaceSession(retired, hostId)
    const staged = cloneWorkspaceSessionState(store.getWorkspaceSession(hostId))
    return {
      value: true,
      rollback: () => {
        const current = store.getWorkspaceSession(hostId)
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
        if (rolledBack !== current) {
          store.setWorkspaceSession(rolledBack, hostId)
        }
      }
    }
  })
}

export type StablePaneSpawnContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  provider: IPtyProvider
  spawnOptions: PtySpawnOptions
  owner: StablePaneOwner | null
  worktreeId?: string
  connectionId?: string | null
  resolveOwner?: () => StablePaneOwner | null
  onFreshSpawn?: (result: PtySpawnResult) => void
  /** Called before attaching an owner that took the pane during the first attach. */
  onOwnerReresolved?: (owner: StablePaneOwner) => void
  /** Only a spawn holding the pane's reservation: it binds next, so its bind swaps the dead id. */
  keepAbsentBinding?: (dead: ReplacedPaneOwner) => void
}

export function stablePanePersistenceFence(
  owner: StablePaneOwner | null
): { ptyId: string; incarnationId?: string } | undefined {
  return owner?.hasPersistedBinding
    ? {
        ptyId: owner.ptyId,
        ...(owner.persistedIncarnationId ? { incarnationId: owner.persistedIncarnationId } : {})
      }
    : undefined
}

export async function persistAdmittedStablePaneBinding(args: {
  store: Store | undefined
  owner: StablePaneOwner | null
  result: PtySpawnResult
  worktreeId: string | undefined
  startupCwd: string | undefined
  correctStartupCwd?: string
  connectionId?: string | null
}): Promise<boolean> {
  const expectedBinding = stablePanePersistenceFence(args.owner)
  if (!args.store || !args.owner || !args.worktreeId) {
    return false
  }
  const binding = {
    worktreeId: args.worktreeId,
    tabId: args.owner.tabId,
    leafId: args.owner.leafId,
    ptyId: args.result.id,
    ...(args.result.incarnationId ? { incarnationId: args.result.incarnationId } : {}),
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    ...(args.correctStartupCwd ? { correctStartupCwd: args.correctStartupCwd } : {}),
    expectedBinding,
    mayCreate: false,
    mayReviveRetiredSurface: false,
    origin: spawnCommitBindingOrigin(args.result)
  }
  const persisted = expectedBinding
    ? await args.store.persistPtyBinding(
        binding,
        args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
      )
    : await persistFreshPaneBinding(args.store, binding, args.connectionId)
  if (persisted === false) {
    throw new Error('terminal_pane_owner_changed')
  }
  return true
}
