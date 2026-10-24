import {
  spawnCommitBindingOrigin,
  type PtySpawnCommitOrigin
} from '../persistence/loading-store/pty-binding-span'
import { isUntypedTerminalInput } from '../../shared/terminal-untyped-input'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'

export type TerminalRunFacts = {
  /** This process was started for its pane, not reattached, adopted or cold-restored. */
  freshSpawn: boolean
  /** When input first drove this process, from any client or driver; null if none has. */
  firstUserInputAt: number | null
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const KITTY_ENTER = '\x1b[13u'

const MAX_PENDING_ESCAPE_LENGTH = 16

/** `pendingEscape` holds a CSI or SS3 sequence a write cut off, so the next write completes it. */
export type ComposerDraftState = { draft: boolean; inPaste: boolean; pendingEscape: string }

/** CSI runs to its final byte; SS3 and Alt+key are ESC plus one or two characters. Null means the
 *  data ends inside a CSI or SS3 sequence. */
function escapeSequenceEnd(data: string, start: number): number | null {
  const introducer = data[start + 1]
  if (introducer === '[') {
    for (let index = start + 2; index < data.length; index += 1) {
      const code = data.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) {
        return index + 1
      }
    }
    return null
  }
  if (introducer === 'O') {
    return start + 3 <= data.length ? start + 3 : null
  }
  // Why: a lone ESC that ends a write is the Esc key, which a terminal sends as its own write.
  return Math.min(start + 2, data.length)
}

/** Walks input the way an agent's composer sees it: typed or pasted text leaves a draft, Enter or
 *  Ctrl+C sends or clears it, and keys such as arrows, Esc or Shift+Enter (ESC CR) change neither. */
function advanceComposerDraft(state: ComposerDraftState, input: string): ComposerDraftState {
  let { draft, inPaste } = state
  const data = state.pendingEscape + input
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index]
    if (char === '\x1b') {
      const end = escapeSequenceEnd(data, index)
      if (end === null) {
        const rest = data.slice(index)
        return {
          draft,
          inPaste,
          pendingEscape: rest.length <= MAX_PENDING_ESCAPE_LENGTH ? rest : ''
        }
      }
      const sequence = data.slice(index, end)
      if (sequence === BRACKETED_PASTE_START) {
        inPaste = true
      } else if (sequence === BRACKETED_PASTE_END) {
        inPaste = false
      } else if (!inPaste && sequence === KITTY_ENTER) {
        draft = false
      }
      index = end - 1
    } else if (inPaste) {
      draft = true
    } else if (char === '\r' || char === '\x03') {
      draft = false
    } else if (char >= ' ' && char !== '\x7f') {
      draft = true
    }
  }
  return { draft, inPaste, pendingEscape: '' }
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
  // Why apart from the run record: input must count on a PTY main adopted without a commit.
  private readonly lastInputAtByPtyId = new Map<string, number>()
  private readonly composerDraftByPtyId = new Map<string, ComposerDraftState>()
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
    const keepsPriorInput =
      prior?.incarnationId === null || prior?.incarnationId === commit.incarnationId
    if (!keepsPriorInput) {
      this.composerDraftByPtyId.delete(commit.id)
    }
    this.pendingByPtyId.set(commit.id, {
      incarnationId: commit.incarnationId,
      firstInputAt: keepsPriorInput ? prior.firstInputAt : null
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
      // Why: input recorded before this commit for the same incarnation was typed into this process.
      if (pending?.incarnationId !== incarnationId) {
        this.composerDraftByPtyId.delete(commit.id)
      }
    }
    this.runsByPtyId.set(commit.id, {
      incarnationId,
      spawnOrigin: origin === 'spawn' && commit.coldRestore !== undefined ? 'cold-restore' : origin,
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
    this.composerDraftByPtyId.set(
      ptyId,
      advanceComposerDraft(
        this.composerDraftByPtyId.get(ptyId) ?? { draft: false, inPaste: false, pendingEscape: '' },
        data
      )
    )
    const run = this.runsByPtyId.get(ptyId)
    if (inputKind === 'driving') {
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
    if (run && inputKind === 'driving') {
      run.firstUserInputAt ??= now
    }
  }

  /** When input other than a terminal reply last reached the PTY's current process, launch writes
   *  included; null if none has. */
  readLastInputAt(ptyId: string): number | null {
    return this.lastInputAtByPtyId.get(ptyId) ?? null
  }

  /** Whether text was typed or pasted into the PTY since the last Enter or Ctrl+C. */
  hasUnsubmittedInput(ptyId: string): boolean {
    return this.composerDraftByPtyId.get(ptyId)?.draft === true
  }

  readComposerDraft(ptyId: string): ComposerDraftState | undefined {
    return this.composerDraftByPtyId.get(ptyId)
  }

  restoreComposerDraft(ptyId: string, state: ComposerDraftState | undefined): void {
    if (state) {
      this.composerDraftByPtyId.set(ptyId, state)
    } else {
      this.composerDraftByPtyId.delete(ptyId)
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
    this.lastInputAtByPtyId.delete(ptyId)
    this.composerDraftByPtyId.delete(ptyId)
    this.pendingByPtyId.delete(ptyId)
  }
}
