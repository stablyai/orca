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
export function isUntypedTerminalInput(payload: string): boolean {
  return isTerminalQueryReply(payload) || TERMINAL_FOCUS_REPORTS_ONLY_RE.test(payload)
}

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const KITTY_ENTER = '\x1b[13u'

export type ComposerDraftState = { draft: boolean; inPaste: boolean }

/** CSI runs to its final byte; SS3 and Alt+key are ESC plus one or two characters. */
function escapeSequenceEnd(data: string, start: number): number {
  const introducer = data[start + 1]
  if (introducer === '[') {
    let index = start + 2
    while (
      index < data.length &&
      (data.charCodeAt(index) < 0x40 || data.charCodeAt(index) > 0x7e)
    ) {
      index += 1
    }
    return Math.min(index + 1, data.length)
  }
  return Math.min(start + (introducer === 'O' ? 3 : 2), data.length)
}

/** Walks input the way an agent's composer sees it: typed or pasted text leaves a draft, Enter or
 *  Ctrl+C sends or clears it, and keys such as arrows, Esc or Shift+Enter (ESC CR) change neither. */
function advanceComposerDraft(state: ComposerDraftState, data: string): ComposerDraftState {
  let { draft, inPaste } = state
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index]
    if (char === '\x1b') {
      const end = escapeSequenceEnd(data, index)
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
  return { draft, inPaste }
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
      this.composerDraftByPtyId.delete(commit.id)
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
        this.composerDraftByPtyId.get(ptyId) ?? { draft: false, inPaste: false },
        data
      )
    )
    const run = this.runsByPtyId.get(ptyId)
    if (inputKind === 'driving') {
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
