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

export type TerminalSpawnCommit = Parameters<typeof spawnCommitBindingOrigin>[0] & {
  id: string
  incarnationId?: string
  coldRestore?: object
}

/** A cold restore starts a new process for a pane that had one, so it is never fresh. */
type TerminalRunSpawnOrigin = PtySpawnCommitOrigin | 'cold-restore'

type TerminalRunRecord = {
  incarnationId: string | null
  spawnOrigin: TerminalRunSpawnOrigin
  firstUserInputAt: number | null
}

/** Main's per-process facts about one PTY run, keyed by the incarnation they describe. */
export class TerminalRunFactsRegister {
  private readonly runsByPtyId = new Map<string, TerminalRunRecord>()

  /** Once per process: a re-registration of the same incarnation keeps its facts. Without an
   *  incarnation a commit cannot be told from a new process, so it starts clean. */
  recordSpawnCommit(commit: TerminalSpawnCommit, expectedSourceBinding?: unknown): void {
    const incarnationId = commit.incarnationId ?? null
    if (
      incarnationId !== null &&
      this.runsByPtyId.get(commit.id)?.incarnationId === incarnationId
    ) {
      return
    }
    const origin = spawnCommitBindingOrigin(commit, expectedSourceBinding)
    this.runsByPtyId.set(commit.id, {
      incarnationId,
      spawnOrigin: origin === 'spawn' && commit.coldRestore !== undefined ? 'cold-restore' : origin,
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
      freshSpawn: run.spawnOrigin === 'spawn' || run.spawnOrigin === 'split',
      firstUserInputAt: run.firstUserInputAt
    }
  }

  delete(ptyId: string): void {
    this.runsByPtyId.delete(ptyId)
  }
}
