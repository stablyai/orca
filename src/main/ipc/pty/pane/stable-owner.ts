import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../../persistence/restoring-sessions/workspace-session-write-rollback'
import { cloneWorkspaceSessionState } from '../../../persistence/restoring-sessions/session-owner-fields'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import type { Store } from '../../../persistence'
import { retireTerminalSurfaceFromPersistence } from '../../../runtime/mobile-session-terminal-persistence-retirement'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  isDaemonEndpointGoneError,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import { stablePaneAttachProvider } from './stable-pane-attach-provider'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { isHostReportedPtyAbsenceError, isObservedPtyExitEvidence } from '../provider/liveness'
import { clearProviderPtyState } from '../provider/state-cleanup'
export {
  stablePanePersistenceFence,
  persistAdmittedStablePaneBinding
} from './stable-pane-binding-persistence'

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
  const registeredConnectionId = ptyOwnership.get(ptyId)
  const parsedSshId = registeredConnectionId === undefined ? parseAppSshPtyId(ptyId) : null
  if ((registeredConnectionId ?? parsedSshId?.connectionId ?? null) !== (connectionId ?? null)) {
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
}

export async function attachStablePaneOwner(
  args: StablePaneSpawnContext & { owner: StablePaneOwner }
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner } | null> {
  const { owner, runtime, spawnOptions } = args
  const { provider, assertOwnerConnected } = stablePaneAttachProvider(owner.ptyId, args.provider)
  let result: PtySpawnResult
  try {
    result = await provider.spawn({
      ...spawnOptions,
      sessionId: owner.ptyId,
      attachOnly: true,
      expectedIncarnationId: owner.runtimeIncarnationId ?? owner.persistedIncarnationId,
      expectedIncarnationIsAuthoritative: owner.runtimeIncarnationId !== undefined,
      isNewSession: undefined,
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: undefined,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined,
      onPtySpawnCommitted: undefined
    })
  } catch (error) {
    assertOwnerConnected()
    if (error instanceof TerminalSessionOwnerUnverifiedError) {
      throw new Error('terminal_pane_owner_unverified')
    }
    // Why: translate before paired-runtime RPC strips the socket error's code and syscall.
    if (isDaemonEndpointGoneError(error)) {
      throw new TerminalHostGoneError()
    }
    if (!isHostReportedPtyAbsenceError(error)) {
      throw error
    }
    const ownerBeforeRetire = args.resolveOwner?.()
    if (
      ownerBeforeRetire &&
      (ownerBeforeRetire.ptyId !== owner.ptyId ||
        ownerBeforeRetire.runtimeIncarnationId !== owner.runtimeIncarnationId ||
        ownerBeforeRetire.hasPersistedBinding !== owner.hasPersistedBinding ||
        ownerBeforeRetire.persistedIncarnationId !== owner.persistedIncarnationId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    // Only observed exit evidence certifies death; relay-map absence remains unverifiable.
    runtime?.onPtyExit(
      owner.ptyId,
      UNVERIFIED_PROCESS_EXIT_CODE,
      owner.incarnationId,
      isObservedPtyExitEvidence(error) ? { hostExitConfirmed: true } : {}
    )
    clearProviderPtyState(owner.ptyId)
    ptyOwnership.delete(owner.ptyId)
    if (
      args.worktreeId &&
      !(await retirePersistedStablePaneOwner(args.store, owner, args.worktreeId, args.connectionId))
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (args.resolveOwner?.()) {
      throw new Error('terminal_pane_owner_changed')
    }
    return null
  }
  assertOwnerConnected()
  if (
    result.id !== owner.ptyId ||
    result.isReattach !== true ||
    (owner.runtimeIncarnationId !== undefined &&
      result.incarnationId !== owner.runtimeIncarnationId) ||
    (result.incarnationId === undefined && owner.incarnationId !== undefined)
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  return { result, owner }
}

export async function spawnForStablePane(
  args: StablePaneSpawnContext
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner | null }> {
  if (args.owner) {
    const attached = await attachStablePaneOwner({ ...args, owner: args.owner })
    if (attached) {
      return attached
    }
  }
  const result = await args.provider.spawn(args.spawnOptions)
  args.onFreshSpawn?.(result)
  return { result, owner: null }
}
