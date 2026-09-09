// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSleepResolvedWorktreeTerminals } from './orca-runtime-sleep-resolved-worktree-terminals'
import { setsEqual } from './runtime-worktree-binding-index'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

export class OrcaRuntimeWithStopExactTerminalsForWorktree extends OrcaRuntimeWithSleepResolvedWorktreeTerminals {
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
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
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
      if (opts.keepHistory) {
        this.intentionalHandlelessPtyStops.set(
          ptyId,
          this.ptysById.get(ptyId)?.incarnationId ?? null
        )
      }
      try {
        if (!(await this.ptyController.stopAndWait(ptyId, { keepHistory: opts.keepHistory }))) {
          throw Object.assign(new Error('terminal_exact_stop_failed'), { ptyId })
        }
      } finally {
        this.intentionalHandlelessPtyStops.delete(ptyId)
      }
      stoppedPtyIds.push(ptyId)
    }
    const postStopLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
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

  protected getLivePtyIdsForWorktree(
    worktreeId: string,
    freshPtyIds?: ReadonlySet<string>
  ): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.connected &&
        leaf.ptyId &&
        (!freshPtyIds || freshPtyIds.has(leaf.ptyId))
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (
        runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) &&
        pty.connected &&
        (!freshPtyIds || freshPtyIds.has(pty.ptyId))
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    return ptyIds
  }

  protected getTerminalHandlesForPtyId(ptyId: string): string[] {
    const handles = new Set(
      this.getLeavesForPty(ptyId)
        .filter((candidate) => candidate.connected)
        .map((leaf) => this.issueHandle(leaf))
    )
    const runtimeHandle = this.handleByPtyId.get(ptyId)
    if (runtimeHandle) {
      handles.add(runtimeHandle)
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
