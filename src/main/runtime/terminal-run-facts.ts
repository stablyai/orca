import {
  spawnCommitBindingOrigin,
  type PtySpawnCommitOrigin
} from '../persistence/loading-store/pty-binding-span'

export type TerminalRunFacts = {
  /** This process was started for its pane, not reattached, adopted or cold-restored. */
  freshSpawn: boolean
  /** When any client first sent this process input a person produced; null if none has. */
  firstUserInputAt: number | null
}

type TerminalRunRecord = {
  incarnationId: string | null
  spawnOrigin: PtySpawnCommitOrigin
  firstUserInputAt: number | null
}

/** Main's per-process facts about one PTY run, keyed by the incarnation they describe. */
export class TerminalRunFactsRegister {
  private readonly runsByPtyId = new Map<string, TerminalRunRecord>()

  /** Once per process: a re-registration of the same incarnation keeps its facts. */
  recordSpawnCommit(
    commit: Parameters<typeof spawnCommitBindingOrigin>[0] & { id: string; incarnationId?: string },
    expectedSourceBinding?: unknown
  ): void {
    const incarnationId = commit.incarnationId ?? null
    if (this.runsByPtyId.get(commit.id)?.incarnationId === incarnationId) {
      return
    }
    this.runsByPtyId.set(commit.id, {
      incarnationId,
      spawnOrigin: spawnCommitBindingOrigin(commit, expectedSourceBinding),
      firstUserInputAt: null
    })
  }

  recordUserInput(ptyId: string, now: number = Date.now()): void {
    const run = this.runsByPtyId.get(ptyId)
    if (run && run.firstUserInputAt === null) {
      run.firstUserInputAt = now
    }
  }

  /** A run main never saw committed reads as not fresh, which keeps today's close-on-exit. */
  read(ptyId: string, incarnationId: string | null | undefined): TerminalRunFacts {
    const run = this.runsByPtyId.get(ptyId)
    if (!run || (run.incarnationId && incarnationId && run.incarnationId !== incarnationId)) {
      return { freshSpawn: false, firstUserInputAt: null }
    }
    return {
      freshSpawn: run.spawnOrigin !== 'reattach',
      firstUserInputAt: run.firstUserInputAt
    }
  }

  delete(ptyId: string): void {
    this.runsByPtyId.delete(ptyId)
  }
}
