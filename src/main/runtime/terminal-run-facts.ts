import {
  spawnCommitBindingOrigin,
  type PtySpawnCommitOrigin
} from '../persistence/loading-store/pty-binding-span'
import { isTerminalQueryReply } from '../../shared/terminal-query-reply'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'

export type TerminalRunFacts = {
  /** This process was started for its pane, not reattached, adopted or cold-restored. */
  freshSpawn: boolean
  /** When input first drove this process, from any client or driver; null if none has. */
  firstUserInputAt: number | null
}

// Why: a paired client's xterm answers focus changes (CSI I / CSI O) through input that carries no
// provenance; the desktop renderer already excludes them via xterm's user-input signal.
// oxlint-disable-next-line no-control-regex -- focus reports are ESC-framed sequences by definition.
const TERMINAL_FOCUS_REPORTS_ONLY_RE = new RegExp('^(?:\\u001b\\[[IO])+$')

/** Input with no provenance that no person typed: a whole terminal reply or only focus reports. */
function isUntypedTerminalInput(payload: string): boolean {
  return isTerminalQueryReply(payload) || TERMINAL_FOCUS_REPORTS_ONLY_RE.test(payload)
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

  /** The one record point both write funnels call just before the provider write, because input
   *  such as `exit` can end the process before the write returns. The payload check backs up a
   *  writer that labels a reply or focus report as driving. */
  recordInput(ptyId: string, inputKind: TerminalInputKind, data: string, now = Date.now()): void {
    if (inputKind !== 'driving') {
      return
    }
    const run = this.runsByPtyId.get(ptyId)
    if (run && run.firstUserInputAt === null && !isUntypedTerminalInput(data)) {
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
