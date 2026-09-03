// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController } from './orca-runtime-refresh-pty-worktree-records-from-controller'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import {
  PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS,
  PTY_CONTROLLER_LIST_TIMEOUT_MS
} from './orca-runtime-postlude'
import type { ExecutionHostId } from '../../shared/execution-host'
import { withTimeoutResult } from './runtime-async-boundaries'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import {
  createIncrementalResolvedWorktreeLookup,
  findResolvedWorktreeIdForPath,
  inferWorktreeIdFromPtyId,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import {
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings
} from './runtime-worktree-binding-index'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { NO_OBSERVING_PROVIDER_REASON } from '../../shared/pty-liveness-verdict'
import { buildControllerTerminalIdentities } from './orca-runtime-build-controller-terminal-identities'
import { retireOrchestrationAuthorityAbsentFromInventory } from './runtime-restored-orchestration-authority-sweep'

export class OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory extends OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController {
  protected async refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId: string | null = null,
    deadline?: number,
    connectionId?: string | null,
    retryStale = false,
    inventoryOptions?: { includeForegroundProcessEvidence?: boolean }
  ): Promise<PtyControllerInventory | null> {
    if (targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      const targetedLiveness = this.refreshFloatingWorkspacePtyLiveness()
      if (targetedLiveness !== null) {
        return {
          livePtyIds: targetedLiveness,
          allLivePtyIds: targetedLiveness,
          terminalIdentityByPtyId: new Map(),
          queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
        }
      }
    }
    if (!this.ptyController?.listProcesses) {
      return null
    }
    const inventoryGeneration = this.ptyControllerInventorySequence + 1
    this.ptyControllerInventorySequence = inventoryGeneration
    const providerKey = typeof connectionId === 'string' ? `ssh:${connectionId}` : 'local'
    const livenessObservationAtStart = this.ptyLivenessObservationSequence
    if (connectionId === undefined) {
      this.ptyControllerAggregateInventoryGeneration = inventoryGeneration
    } else {
      this.ptyControllerInventoryGenerationByProvider.set(providerKey, inventoryGeneration)
    }
    const listBudgetMs =
      deadline === undefined
        ? PTY_CONTROLLER_LIST_TIMEOUT_MS
        : Math.max(1, Math.min(PTY_CONTROLLER_LIST_TIMEOUT_MS, deadline - Date.now()))
    // Why: give each provider a deadline strictly inside our own, so a relay that
    // never answers still leaves the aggregate time to return the providers that did
    // — expiring at the same instant would discard the whole inventory instead.
    const providerListOpts = {
      deadlineMs: Date.now() + Math.max(1, listBudgetMs - PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS),
      ...(inventoryOptions?.includeForegroundProcessEvidence === undefined
        ? {}
        : { includeForegroundProcessEvidence: inventoryOptions.includeForegroundProcessEvidence })
    }
    const processInventory =
      connectionId === undefined && this.ptyController.listProcessesWithHostScope
        ? this.ptyController.listProcessesWithHostScope(providerListOpts)
        : this.ptyController.listProcesses(connectionId, providerListOpts).then((processes) => {
            const hostId: ExecutionHostId =
              connectionId === undefined || connectionId === null
                ? LOCAL_EXECUTION_HOST_ID
                : toSshExecutionHostId(connectionId)
            return { processes, hostIds: [hostId] }
          })
    const sessionsResult = await withTimeoutResult(processInventory, listBudgetMs)
    if (!sessionsResult.ok) {
      // Why: a transient controller failure is not evidence that retained PTYs exited.
      return null
    }
    const isCurrentInventory =
      connectionId === undefined
        ? this.ptyControllerAggregateInventoryGeneration === inventoryGeneration &&
          ![...this.ptyControllerInventoryGenerationByProvider.values()].some(
            (generation) => generation > inventoryGeneration
          )
        : this.ptyControllerInventoryGenerationByProvider.get(providerKey) ===
            inventoryGeneration &&
          this.ptyControllerAggregateInventoryGeneration <= inventoryGeneration
    if (!isCurrentInventory) {
      // A fleet census that began after this targeted poll must not turn a
      // user-driven open into an empty result. Re-query the owning provider;
      // the second generation is then fenced against both operations.
      if (targetWorktreeId !== null && !retryStale) {
        return this.refreshPtyWorktreeRecordsWithControllerInventory(
          resolvedWorktrees,
          targetWorktreeId,
          deadline,
          connectionId,
          true,
          inventoryOptions
        )
      }
      return null
    }
    const sessions = sessionsResult.value.processes
    const queriedHostIds = new Set<ExecutionHostId>(sessionsResult.value.hostIds)
    if (connectionId === undefined) {
      for (const session of sessions) {
        const hostId = getPtyExecutionHost(session.id)
        if (hostId && hostId !== 'foreign' && parseExecutionHostId(hostId)?.kind === 'ssh') {
          queriedHostIds.add(hostId)
        }
      }
    }
    const { controllerIdentityByPtyId } = buildControllerTerminalIdentities(sessions)
    const findResolvedWorktree = createIncrementalResolvedWorktreeLookup(resolvedWorktrees)
    const persistedIndexesByHostId = new Map<
      ExecutionHostId,
      {
        worktreeIdByPtyId: ReadonlyMap<string, string>
        surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
      }
    >()
    const getPersistedIndexes = (hostId: ExecutionHostId) => {
      const existing = persistedIndexesByHostId.get(hostId)
      if (existing) {
        return existing
      }
      const persistedSession = this.store?.getWorkspaceSession?.(hostId)
      const indexes = {
        worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
        surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
      }
      persistedIndexesByHostId.set(hostId, indexes)
      return indexes
    }
    const allLivePtyIds = new Set(sessions.map((session) => session.id))
    const selectedLivePtyIds = new Set<string>()
    for (const session of sessions) {
      // The owning inventory positively observed this PTY again; prior lost-contact doubt is stale.
      this.forgetPtyLivenessVerdict(session.id, livenessObservationAtStart)
      const sessionConnectionId =
        parseAppSshPtyId(session.id)?.connectionId ??
        (typeof connectionId === 'string' ? connectionId : null)
      const persistedIndexes = getPersistedIndexes(
        sessionConnectionId ? toSshExecutionHostId(sessionConnectionId) : LOCAL_EXECUTION_HOST_ID
      )
      const controllerIdentity = controllerIdentityByPtyId.get(session.id)
      const persistedWorktreeId = persistedIndexes.worktreeIdByPtyId.get(session.id)
      const providerWorktree = session.worktreeId
        ? findResolvedWorktree(session.worktreeId)
        : undefined
      const inferredWorktreeId = inferWorktreeIdFromPtyId(session.id)
      const persistedWorktree = persistedWorktreeId
        ? findResolvedWorktree(persistedWorktreeId)
        : undefined
      const hasMigrationEvidence =
        Boolean(session.worktreeId) &&
        !providerWorktree &&
        Boolean(persistedWorktree) &&
        Boolean(inferredWorktreeId) &&
        runtimeWorktreeIdsEqual(session.worktreeId as string, inferredWorktreeId as string)
      // Why: an unresolved explicit provider owner remains authoritative unless the session id proves it was frozen before a persisted rename migration.
      const worktreeId = providerWorktree
        ? providerWorktree.id
        : hasMigrationEvidence
          ? (persistedWorktree?.id ?? null)
          : (session.worktreeId ??
            persistedWorktree?.id ??
            inferredWorktreeId ??
            findResolvedWorktreeIdForPath(resolvedWorktrees, session.cwd, targetWorktreeId))
      const persistedSurface = persistedIndexes.surfaceByPtyId.get(session.id)
      const restoresExactSurface =
        persistedSurface &&
        session.incarnationId &&
        persistedSurface.incarnationId === session.incarnationId &&
        Boolean(worktreeId) &&
        runtimeWorktreeIdsEqual(persistedSurface.worktreeId, worktreeId as string)
      this.adoptControllerTerminalHandle(
        session.id,
        controllerIdentity?.handle ?? session.terminalHandle,
        controllerIdentity?.incarnationId ?? session.incarnationId,
        { exactRestoredSurface: Boolean(restoresExactSurface && controllerIdentity) }
      )
      if (
        !targetWorktreeId ||
        (worktreeId && runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        selectedLivePtyIds.add(session.id)
      }
      if (
        targetWorktreeId &&
        (!worktreeId || !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId))
      ) {
        const receipt = this.restoredOrchestrationAuthorityByPtyId.get(session.id)
        if (receipt && runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)) {
          this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
        }
        continue
      }
      this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
      if (worktreeId) {
        const pty = this.recordPtyWorktree(session.id, worktreeId, {
          connected: true,
          ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
          agentSessionOwners: session.incarnationId ? (session.agentSessionOwners ?? []) : [],
          ...(session.wslDistro !== undefined
            ? { isWsl: Boolean(session.wslDistro), wslDistro: session.wslDistro }
            : {}),
          ...(restoresExactSurface
            ? { tabId: persistedSurface.tabId, paneKey: persistedSurface.paneKey }
            : {})
        })
        if (restoresExactSurface && controllerIdentity) {
          this.rememberRestoredOrchestrationAuthority(
            pty,
            controllerIdentity.handle,
            controllerIdentity.incarnationId
          )
        } else {
          this.restoredOrchestrationAuthorityByPtyId.delete(session.id)
        }
        pty.controllerTitle = session.title?.trim() || null
        this.reconcileSubscriberDrivenProviderAttach(session.id)
      }
      // Why: fire-and-forget so this listing hot path doesn't serialize a relay round-trip per session and a throw can't abort the sweep below.
      this.refreshPtyForegroundAgent(session.id)
    }
    for (const pty of this.ptysById.values()) {
      if (connectionId !== undefined && pty.connectionId !== connectionId) {
        continue
      }
      const encodedHostId = getPtyExecutionHost(pty.ptyId)
      const ptyHostId =
        encodedHostId === 'foreign'
          ? null
          : (encodedHostId ??
            (pty.connectionId ? toSshExecutionHostId(pty.connectionId) : LOCAL_EXECUTION_HOST_ID))
      if (!ptyHostId) {
        continue
      }
      // An inventory can prove absence only for hosts that actually answered.
      if (!queriedHostIds.has(ptyHostId)) {
        if (this.isSshOwnedPtyId(pty.ptyId) && this.ptyController.hasPty?.(pty.ptyId) == null) {
          this.markPtyLivenessUnverifiable(pty.ptyId, NO_OBSERVING_PROVIDER_REASON)
        }
        continue
      }
      if (!allLivePtyIds.has(pty.ptyId) && !this.leafExistsForPty(pty.ptyId)) {
        const currentVerdict = this.ptyLivenessVerdictByPtyId.get(pty.ptyId)
        if (
          currentVerdict &&
          currentVerdict.observedAt > livenessObservationAtStart &&
          currentVerdict.verdict.status === 'unverifiable'
        ) {
          pty.connected = false
          pty.disconnectedAt ??= Date.now()
          continue
        }
        const observed = this.ptyController.hasPty?.(pty.ptyId)
        if (observed === true) {
          // Why: an SSH spawn can become addressable before an overlapping relay list includes it.
          allLivePtyIds.add(pty.ptyId)
          if (
            !targetWorktreeId ||
            (pty.worktreeId && runtimeWorktreeIdsEqual(pty.worktreeId, targetWorktreeId))
          ) {
            selectedLivePtyIds.add(pty.ptyId)
          }
          pty.connected = true
          pty.disconnectedAt = null
          this.forgetPtyLivenessVerdict(pty.ptyId)
          continue
        }
        pty.connected = false
        pty.disconnectedAt ??= Date.now()
        pty.agentSessionOwners = []
        // Why: this list only enumerates registered providers, so a dropped relay
        // clears `connected` for every one of its PTYs at once. Only `false` here
        // is an observed absence; `null` means no provider could be asked.
        if (observed === false) {
          // Drops the doubt without asserting a death: `pty.listProcesses` returns the relay's
          // CURRENT session map, so a restarted relay omits every id the previous one minted
          // whether or not those shells died. That is the same union as pty.attach's not-found,
          // and neither earns `exited` (docs/reference/ssh-execution-boundary.md).
          this.forgetPtyLivenessVerdict(pty.ptyId)
        } else if (observed === null && this.isSshOwnedPtyId(pty.ptyId)) {
          this.markPtyLivenessUnverifiable(pty.ptyId, NO_OBSERVING_PROVIDER_REASON)
        }
      }
    }
    // Why: runs after the hasPty rescue so a still-addressable pane keeps its receipt.
    retireOrchestrationAuthorityAbsentFromInventory(this.restoredOrchestrationAuthorityByPtyId, {
      queriedHostIds,
      allLivePtyIds,
      connectionId
    })
    this.pruneDisconnectedPtyRecords()
    return {
      livePtyIds: targetWorktreeId ? selectedLivePtyIds : allLivePtyIds,
      allLivePtyIds,
      terminalIdentityByPtyId: controllerIdentityByPtyId,
      queriedHostIds
    }
  }
}
