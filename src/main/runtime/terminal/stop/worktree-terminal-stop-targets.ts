import { setTimeout as delay } from 'node:timers/promises'
import { OrcaRuntimeWithSleepResolvedWorktreeTerminals } from './worktree-terminal-sleep'
import { setsEqual } from '../../runtime-worktree-binding-index'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { worktreePtyBelongsToHost, type WorktreePtyHostFence } from '../../worktree-pty-host-fence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { mainHoldsTerminal } from '../surface/main-pane-verdict'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../orca-runtime-postlude'

// Overlapping inventories can invalidate post-stop checks; retry within a fresh list budget before calling confirmed exits unverifiable.
const POST_STOP_LIVENESS_RETRY_MS = PTY_CONTROLLER_LIST_TIMEOUT_MS
const POST_STOP_LIVENESS_RETRY_DELAY_MS = 100

export abstract class OrcaRuntimeWithStopExactTerminalsForWorktree extends OrcaRuntimeWithSleepResolvedWorktreeTerminals {
  protected abstract issueHandle(leaf: RuntimeLeafRecord): string

  async stopExactTerminalsForWorktree(
    worktreeSelector: string,
    expectedPtyIds: readonly string[],
    opts: { keepHistory?: boolean; targetOnly?: boolean } = {}
  ): Promise<{
    stopped: number
    stoppedPtyIds: string[]
    livePtyIds: string[]
    postStopVerified: boolean
    postStopFailure?: string
    remainingLivePtyIds?: string[]
  }> {
    // Why: exact stop hibernates one known pane; worktree sleep discovers its complete host-owned set separately.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const expected = new Set(expectedPtyIds.filter((ptyId) => ptyId.length > 0))
    if (expected.size !== 1) {
      throw new Error('terminal_exact_stop_requires_single_pty')
    }
    const resolvedWorktrees = [...(await this.getResolvedWorktreeMap()).values()]
    const refreshedPtyLiveness =
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    if (!refreshedPtyLiveness) {
      throw new Error('terminal_liveness_unavailable')
    }
    const livePtyIds = this.getLivePtyIdsForWorktree(worktree.id, refreshedPtyLiveness)
    const targetOnly = opts.targetOnly === true
    const expectedIsLive = [...expected].every((ptyId) => livePtyIds.has(ptyId))
    if (targetOnly ? !expectedIsLive : !setsEqual(livePtyIds, expected)) {
      const error = Object.assign(new Error('terminal_stop_pty_set_mismatch'), {
        livePtyIds: [...livePtyIds].sort(),
        expectedPtyIds: [...expected].sort()
      })
      throw error
    }

    if (!this.ptyController?.stopAndWait) {
      throw new Error('terminal_exact_stop_unavailable')
    }

    const stoppedPtyIds: string[] = []
    for (const ptyId of [...expected].sort()) {
      // Why: exact-stop is the sleep transaction boundary; its exit must leave the sleeping surface for wake.
      const settleStop = opts.keepHistory
        ? this.intentionalPtyStops.mark(
            ptyId,
            'reversible',
            this.ptysById.get(ptyId)?.incarnationId ?? null
          )
        : null
      let stopped = false
      try {
        stopped = await this.ptyController.stopAndWait(ptyId, { keepHistory: opts.keepHistory })
      } finally {
        settleStop?.(stopped)
      }
      if (!stopped) {
        throw Object.assign(new Error('terminal_exact_stop_failed'), { ptyId })
      }
      stoppedPtyIds.push(ptyId)
    }
    const postStopLiveness = await this.refreshPostStopPtyLiveness(resolvedWorktrees)
    if (!postStopLiveness) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      }
    }
    const remainingLivePtyIds = this.getLivePtyIdsForWorktree(worktree.id, postStopLiveness)
    const stoppedTargetsStillLive = [...expected].filter((ptyId) => remainingLivePtyIds.has(ptyId))
    if (targetOnly ? stoppedTargetsStillLive.length > 0 : remainingLivePtyIds.size > 0) {
      return {
        stopped: stoppedPtyIds.length,
        stoppedPtyIds,
        livePtyIds: [...livePtyIds].sort(),
        postStopVerified: false,
        postStopFailure: 'terminal_exact_stop_still_live',
        remainingLivePtyIds: [...remainingLivePtyIds].sort()
      }
    }
    return {
      stopped: stoppedPtyIds.length,
      stoppedPtyIds,
      livePtyIds: [...livePtyIds].sort(),
      postStopVerified: true,
      ...(targetOnly && remainingLivePtyIds.size > 0
        ? { remainingLivePtyIds: [...remainingLivePtyIds].sort() }
        : {})
    }
  }

  private async refreshPostStopPtyLiveness(
    resolvedWorktrees: ResolvedWorktree[]
  ): Promise<Set<string> | null> {
    const deadline = Date.now() + POST_STOP_LIVENESS_RETRY_MS
    for (;;) {
      const liveness = await this.refreshPtyWorktreeRecordsFromController(
        resolvedWorktrees,
        null,
        deadline
      )
      if (liveness || Date.now() + POST_STOP_LIVENESS_RETRY_DELAY_MS >= deadline) {
        return liveness
      }
      await delay(POST_STOP_LIVENESS_RETRY_DELAY_MS)
    }
  }

  /** With `hostFence`, only that host's copy: a same-id twin's PTYs are another host's. */
  protected getLivePtyIdsForWorktree(
    worktreeId: string,
    freshPtyIds?: ReadonlySet<string>,
    hostFence?: WorktreePtyHostFence
  ): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        worktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.connected &&
        leaf.ptyId &&
        (!freshPtyIds || freshPtyIds.has(leaf.ptyId))
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (
        worktreeIdsEqual(pty.worktreeId, worktreeId) &&
        pty.connected &&
        (!freshPtyIds || freshPtyIds.has(pty.ptyId))
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    // Main-bound terminals can survive listing gaps; only certified exits or fresh inventory remove them.
    for (const pty of ORCA_LAYOUT_OWNER_IS_MAIN ? this.ptysById.values() : []) {
      if (
        worktreeIdsEqual(pty.worktreeId, worktreeId) &&
        mainHoldsTerminal(this, pty.ptyId) &&
        this.getPtyLivenessVerdict(pty.ptyId)?.status !== 'exited' &&
        (!freshPtyIds || freshPtyIds.has(pty.ptyId))
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    if (hostFence) {
      for (const ptyId of ptyIds) {
        if (!worktreePtyBelongsToHost(ptyId, this.ptysById.get(ptyId)?.connectionId, hostFence)) {
          ptyIds.delete(ptyId)
        }
      }
    }
    return ptyIds
  }

  protected getTerminalHandlesForPtyId(ptyId: string): string[] {
    const handles = new Set(this.getExistingTerminalHandlesForPtyId(ptyId))
    for (const handle of this.getLeavesForPty(ptyId)
      .filter((candidate) => candidate.connected)
      .map((leaf) => this.issueHandle(leaf))) {
      handles.add(handle)
    }
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (!pty) {
      throw Object.assign(new Error('terminal_worktree_sleep_handle_unavailable'), { ptyId })
    }
    if (handles.size === 0) {
      handles.add(this.issuePtyHandle(pty))
    }
    return [...handles].sort()
  }

  protected getExistingTerminalHandlesForPtyId(ptyId: string): string[] {
    const handles = new Set(
      this.getLeavesForPty(ptyId)
        .map((leaf) => this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)))
        .filter((handle): handle is string => handle !== undefined)
    )
    const runtimeHandle = this.handleByPtyId.get(ptyId)
    if (runtimeHandle) {
      handles.add(runtimeHandle)
    }
    const incarnationHandle = this.handleByPtyIncarnation.get(ptyId)?.handle
    if (incarnationHandle) {
      handles.add(incarnationHandle)
    }
    return [...handles].sort()
  }

  protected getRecordedTerminalSleepHandles(
    ptyIds: Iterable<string>,
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  ): string[] {
    return [...new Set([...ptyIds].flatMap((ptyId) => terminalHandlesByPtyId[ptyId] ?? []))].sort()
  }

  protected commitWorktreeTerminalSleepPtys(args: {
    worktreeId: string
    generation: number
    ptyIds: readonly string[]
    pendingPtyIds: Set<string>
    committedPtyIds: Set<string>
    terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
  }): void {
    const newlyCommittedPtyIds = [...new Set(args.ptyIds)]
      .filter((ptyId) => !args.committedPtyIds.has(ptyId))
      .sort()
    for (const ptyId of newlyCommittedPtyIds) {
      args.pendingPtyIds.delete(ptyId)
      args.committedPtyIds.add(ptyId)
    }
    if (newlyCommittedPtyIds.length === 0) {
      return
    }
    this.emitClientEvent({
      type: 'worktreeTerminalSleepState',
      worktreeId: args.worktreeId,
      generation: args.generation,
      phase: 'committed',
      ptyIds: newlyCommittedPtyIds,
      terminalHandles: this.getRecordedTerminalSleepHandles(
        newlyCommittedPtyIds,
        args.terminalHandlesByPtyId
      )
    })
  }
}
