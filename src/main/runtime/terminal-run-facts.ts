import {
  spawnCommitBindingOrigin,
  type PtySpawnCommitOrigin
} from '../persistence/loading-store/pty-binding-span'
import { isUntypedTerminalInput } from '../../shared/terminal-untyped-input'
import { isDrivingInputKind, type TerminalInputKind } from '../../shared/terminal-input-kind'

export type TerminalRunFacts = {
  /** This process was started for its pane, not reattached, adopted or cold-restored. */
  freshSpawn: boolean
  /** When input first drove this process, from any client or driver; null if none has. */
  firstUserInputAt: number | null
}

export type TerminalSpawnCommit = Parameters<typeof spawnCommitBindingOrigin>[0] & {
  id: string
  incarnationId?: string
  coldRestore?: object
  /** Taken before the spawn, or a fast process's first report would read as older than it. */
  spawnRequestedAt?: number
}

/** A cold restore starts a new process for a pane that had one, so it is never fresh. */
type TerminalRunSpawnOrigin = PtySpawnCommitOrigin | 'cold-restore'

type TerminalRunRecord = {
  incarnationId: string | null
  spawnOrigin: TerminalRunSpawnOrigin
  firstUserInputAt: number | null
  /** When main committed a process it started (spawn, split or cold restore); null for one it
   *  attached to, whose start main never saw. */
  processStartedAt: number | null
}

// Why not the binding origin: a split outranks a reattach there, but only an attach keeps a process.
function startedNewProcess(commit: TerminalSpawnCommit): boolean {
  return commit.isReattach !== true && commit.agentSessionEnsure?.disposition !== 'adopted'
}

/** Main's per-process facts about one PTY run, keyed by the incarnation they describe. */
export class TerminalRunFactsRegister {
  private readonly runsByPtyId = new Map<string, TerminalRunRecord>()
  // Why apart from the run record: input must count on a PTY main adopted without a commit.
  private readonly lastInputAtByPtyId = new Map<string, number>()
  private readonly lastDrivingInputAtByPtyId = new Map<string, number>()
  private readonly pendingByPtyId = new Map<
    string,
    { incarnationId: string | null; firstInputAt: number | null }
  >()
  private readonly inputListeners = new Set<(ptyId: string, now: number) => void>()

  /** Called on driving input from any client (not launch writes or replies); keep it cheap. */
  onInput(listener: (ptyId: string, now: number) => void): () => void {
    this.inputListeners.add(listener)
    return () => this.inputListeners.delete(listener)
  }

  reserveSpawnCommit(commit: TerminalSpawnCommit): void {
    if (!commit.incarnationId) {
      return
    }
    const prior = this.pendingByPtyId.get(commit.id)
    this.pendingByPtyId.set(commit.id, {
      incarnationId: commit.incarnationId,
      firstInputAt:
        prior?.incarnationId === null || prior?.incarnationId === commit.incarnationId
          ? prior.firstInputAt
          : null
    })
  }

  discardSpawnCommit(commit: TerminalSpawnCommit): void {
    if (this.pendingByPtyId.get(commit.id)?.incarnationId === (commit.incarnationId ?? null)) {
      this.pendingByPtyId.delete(commit.id)
    }
  }

  /** Once per process: a re-registration of the same incarnation keeps its facts, and so does a
   *  reattach or adoption of the running process unless its incarnation shows another process. */
  recordSpawnCommit(commit: TerminalSpawnCommit, expectedSourceBinding?: unknown): void {
    const incarnationId = commit.incarnationId ?? null
    const previous = this.runsByPtyId.get(commit.id)
    const pending = this.pendingByPtyId.get(commit.id)
    this.pendingByPtyId.delete(commit.id)
    if (incarnationId !== null && previous?.incarnationId === incarnationId) {
      return
    }
    const origin = spawnCommitBindingOrigin(commit, expectedSourceBinding)
    const sameProcess =
      origin === 'reattach' && (incarnationId === null || !previous?.incarnationId)
    if (!sameProcess) {
      this.lastInputAtByPtyId.delete(commit.id)
      this.lastDrivingInputAtByPtyId.delete(commit.id)
    }
    this.runsByPtyId.set(commit.id, {
      incarnationId,
      spawnOrigin: origin === 'spawn' && commit.coldRestore !== undefined ? 'cold-restore' : origin,
      processStartedAt: sameProcess
        ? (previous?.processStartedAt ?? null)
        : startedNewProcess(commit)
          ? (commit.spawnRequestedAt ?? Date.now())
          : null,
      firstUserInputAt: sameProcess
        ? (previous?.firstUserInputAt ?? null)
        : pending?.incarnationId === incarnationId
          ? pending.firstInputAt
          : null
    })
  }

  /** The one record point both write funnels call just before the provider write, because input
   *  such as `exit` can end the process before the write returns. The payload check backs up a
   *  writer that labels a reply or focus report as driving. */
  recordInput(ptyId: string, inputKind: TerminalInputKind, data: string, now = Date.now()): void {
    if (inputKind === 'query-reply' || isUntypedTerminalInput(data)) {
      return
    }
    this.lastInputAtByPtyId.set(ptyId, now)
    const run = this.runsByPtyId.get(ptyId)
    if (isDrivingInputKind(inputKind)) {
      if (inputKind === 'driving') {
        this.lastDrivingInputAtByPtyId.set(ptyId, now)
      }
      for (const listener of this.inputListeners) {
        listener(ptyId, now)
      }
      const pending = this.pendingByPtyId.get(ptyId)
      if (pending) {
        pending.firstInputAt ??= now
      } else if (!run) {
        this.pendingByPtyId.set(ptyId, { incarnationId: null, firstInputAt: now })
      }
    }
    if (run && isDrivingInputKind(inputKind)) {
      run.firstUserInputAt ??= now
    }
  }

  /** When input other than a terminal reply last reached the PTY's current process, launch writes
   *  included; null if none has. */
  readLastInputAt(ptyId: string): number | null {
    return this.lastInputAtByPtyId.get(ptyId) ?? null
  }

  /** Like readLastInputAt, but only `driving` input, so Orca's own launch and orchestration writes don't count. */
  readLastDrivingInputAt(ptyId: string): number | null {
    return this.lastDrivingInputAtByPtyId.get(ptyId) ?? null
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

  /** When the PTY's current process was started by main; null when main attached to it instead,
   *  so evidence older than that may still describe it. A run older than the PTY's live process
   *  only understates that start, so callers may omit the incarnation. */
  readProcessStartedAt(ptyId: string, incarnationId?: string | null): number | null {
    const run = this.runsByPtyId.get(ptyId)
    if (!run || (run.incarnationId && incarnationId && run.incarnationId !== incarnationId)) {
      return null
    }
    return run.processStartedAt
  }

  delete(ptyId: string): void {
    this.runsByPtyId.delete(ptyId)
    this.lastInputAtByPtyId.delete(ptyId)
    this.lastDrivingInputAtByPtyId.delete(ptyId)
    this.pendingByPtyId.delete(ptyId)
  }
}
