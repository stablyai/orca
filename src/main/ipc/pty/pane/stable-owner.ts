import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  sameTerminalOwnerIdentity,
  type TerminalOwnerIdentity
} from '../../../../shared/terminal-owner-identity'
import type { Store } from '../../../persistence'
import { retireTerminalSurfaceFromPersistence } from '../../../runtime/mobile-session-terminal-persistence-retirement'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'

export type StablePaneOwner = {
  handle?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  hasPersistedBinding?: true
  persistedIncarnationId?: string
  runtimeIncarnationId?: string
  ownerIdentity?: TerminalOwnerIdentity
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
): Pick<StablePaneOwner, 'tabId' | 'leafId' | 'ptyId' | 'incarnationId' | 'ownerIdentity'> | null {
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
  const ownerIdentity = session.terminalPtyOwnersByPaneKey?.[paneKey]
  return {
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    ptyId,
    ...(incarnationId ? { incarnationId } : {}),
    ...(ownerIdentity ? { ownerIdentity } : {})
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
  const registeredConnectionId = ptyOwnership.get(ptyId)
  const parsedSshId = registeredConnectionId === undefined ? parseAppSshPtyId(ptyId) : null
  const ownerConnectionId = registeredConnectionId ?? parsedSshId?.connectionId ?? null
  if (ownerConnectionId !== (connectionId ?? null)) {
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
    ...(persisted?.ownerIdentity ? { ownerIdentity: persisted.ownerIdentity } : {}),
    ...(persisted ? { hasPersistedBinding: true as const } : {}),
    ...(persisted?.incarnationId ? { persistedIncarnationId: persisted.incarnationId } : {}),
    ...(runtimeIncarnationId ? { runtimeIncarnationId } : {})
  }
}

export function retirePersistedStablePaneOwner(
  store: Store | undefined,
  owner: StablePaneOwner,
  worktreeId: string,
  connectionId: string | null | undefined
): boolean {
  if (!store) {
    return false
  }
  const paneKey = makePaneKey(owner.tabId, owner.leafId)
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const current = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
  if (!current) {
    // Why: persistence already dropped this pane binding (an earlier stop retired it while the
    // runtime kept history), so there is nothing left to clear — that is a completed retirement,
    // not a competing owner. Reporting failure here strands the pane after its PTY is proven dead.
    return true
  }
  const ownerIdentityMatches = owner.ownerIdentity
    ? sameTerminalOwnerIdentity(current.ownerIdentity, owner.ownerIdentity)
    : current.ownerIdentity === undefined
  if (
    current.ptyId !== owner.ptyId ||
    current.incarnationId !== owner.persistedIncarnationId ||
    !ownerIdentityMatches
  ) {
    return false
  }
  const session = store.getWorkspaceSession(hostId)
  const retired = retireTerminalSurfaceFromPersistence(session, {
    worktreeId,
    parentTabId: owner.tabId,
    leafId: owner.leafId,
    ptyId: owner.ptyId,
    ...(current.incarnationId ? { incarnationId: current.incarnationId } : {})
  })
  if (retired === session) {
    return false
  }
  store.setWorkspaceSession(retired, hostId)
  try {
    store.flushOrThrow()
  } catch (error) {
    store.setWorkspaceSession(session, hostId)
    throw error
  }
  return true
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
}

export function stablePanePersistenceFence(owner: StablePaneOwner | null):
  | {
      ptyId: string
      incarnationId?: string
      ownerIdentity?: TerminalOwnerIdentity | null
    }
  | undefined {
  return owner?.hasPersistedBinding
    ? {
        ptyId: owner.ptyId,
        ...(owner.persistedIncarnationId ? { incarnationId: owner.persistedIncarnationId } : {}),
        ownerIdentity: owner.ownerIdentity ?? null
      }
    : undefined
}

export function persistAdmittedStablePaneBinding(args: {
  store: Store | undefined
  owner: StablePaneOwner | null
  result: PtySpawnResult
  worktreeId: string | undefined
  startupCwd: string | undefined
  connectionId: string | null | undefined
}): boolean {
  const expectedBinding = stablePanePersistenceFence(args.owner)
  if (!args.store || !args.owner || !args.worktreeId || !expectedBinding) {
    return false
  }
  const persisted = args.store.persistPtyBinding(
    {
      worktreeId: args.worktreeId,
      tabId: args.owner.tabId,
      leafId: args.owner.leafId,
      ptyId: args.result.id,
      ...(args.result.incarnationId ? { incarnationId: args.result.incarnationId } : {}),
      ...(args.result.ownerIdentity ? { ownerIdentity: args.result.ownerIdentity } : {}),
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
      expectedBinding
    },
    args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
  )
  if (persisted === false) {
    throw new Error('terminal_pane_owner_changed')
  }
  return true
}
