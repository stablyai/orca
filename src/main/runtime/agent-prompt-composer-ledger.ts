import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import {
  composerNoLongerShowsAgentPromptPaste,
  type AgentPromptOwnPaste
} from './agent-prompt-composer-residue'

// Why: right after Orca's own Enter the emulator can still paint the prompt it just submitted.
const AGENT_PROMPT_COMPOSER_SETTLE_MS = 1_000
// Why: a turn start proves the agent took the prompt, so its text still on screen is a late repaint;
// long after that, or once the composer was seen repainted, the same text is someone's draft again.
const AGENT_PROMPT_LANDED_REPAINT_MS = 10_000

/** Calls back with the pane's composer, asynchronously, each time its screen model has parsed
 *  the output received so far; the returned function stops the callbacks. */
export type AgentPromptComposerWatch = (
  ptyId: string,
  onParsed: (context: TerminalCursorContext | null | undefined) => void
) => () => void

type OwnPasteRecord = {
  generation: number
  payload: string
  landedAt: number | null
  repainted: boolean
}

/** Per pane: Orca's own last prompt paste and Enter, the evidence a composer verdict rests on. */
export class AgentPromptComposerLedger {
  private readonly submittedAtByPtyId = new Map<string, { generation: number; at: number }>()
  private readonly lastPasteByPtyId = new Map<string, OwnPasteRecord>()
  private readonly repaintWatchByPtyId = new Map<string, { stop: () => void }>()

  constructor(private readonly watchComposer: AgentPromptComposerWatch) {}

  markSubmitted(ptyId: string, generation: number): void {
    const now = Date.now()
    // Why prune here: only Enters inside the settle window matter, so the map stays tiny.
    for (const [id, submitted] of this.submittedAtByPtyId) {
      if (now - submitted.at >= AGENT_PROMPT_COMPOSER_SETTLE_MS) {
        this.submittedAtByPtyId.delete(id)
      }
    }
    this.submittedAtByPtyId.set(ptyId, { generation, at: now })
  }

  /** How long a composer read must still wait for Orca's own Enter to clear the screen. */
  settleMsLeft(ptyId: string, generation: number): number {
    const submitted = this.submittedAtByPtyId.get(ptyId)
    if (submitted?.generation !== generation) {
      return 0
    }
    return Math.max(0, submitted.at + AGENT_PROMPT_COMPOSER_SETTLE_MS - Date.now())
  }

  rememberPaste(
    ptyId: string,
    generation: number,
    payload: string,
    isLivePty: (ptyId: string) => boolean
  ): void {
    // Why prune here: only live panes can be judged again, so the map stays one entry per pane.
    for (const id of this.lastPasteByPtyId.keys()) {
      if (!isLivePty(id)) {
        this.lastPasteByPtyId.delete(id)
        this.stopRepaintWatch(id)
      }
    }
    this.stopRepaintWatch(ptyId)
    this.lastPasteByPtyId.set(ptyId, { generation, payload, landedAt: null, repainted: false })
  }

  markLanded(ptyId: string, generation: number, payload: string): void {
    const paste = this.lastPasteByPtyId.get(ptyId)
    if (paste?.generation !== generation || paste.payload !== payload) {
      return
    }
    paste.landedAt = Date.now()
    this.stopRepaintWatch(ptyId)
    // Why watch: a late repaint leaves the landed text untouched, while a recalled or retyped
    // draft first needs the composer to read otherwise. Once it has, the exemption ends; a read
    // that cannot see the composer does not end it, because doubt never blocks a write.
    const watch = { stop: (): void => {} }
    this.repaintWatchByPtyId.set(ptyId, watch)
    const unsubscribe = this.watchComposer(ptyId, (context) => {
      if (this.repaintWatchByPtyId.get(ptyId) !== watch) {
        return
      }
      if (composerNoLongerShowsAgentPromptPaste(context, payload)) {
        paste.repainted = true
        this.stopRepaintWatch(ptyId)
      }
    })
    // Why: past the window the verdict no longer needs the watch, even on a pane gone quiet.
    const expiry = setTimeout(() => {
      if (this.repaintWatchByPtyId.get(ptyId) === watch) {
        this.stopRepaintWatch(ptyId)
      }
    }, AGENT_PROMPT_LANDED_REPAINT_MS)
    expiry.unref?.()
    watch.stop = () => {
      clearTimeout(expiry)
      unsubscribe()
    }
  }

  getOwnPaste(ptyId: string, generation: number): AgentPromptOwnPaste | null {
    const paste = this.lastPasteByPtyId.get(ptyId)
    if (paste?.generation !== generation) {
      return null
    }
    if (paste.landedAt === null) {
      return { payload: paste.payload, landed: false }
    }
    return !paste.repainted && isInLandedRepaintWindow(paste)
      ? { payload: paste.payload, landed: true }
      : null
  }

  private stopRepaintWatch(ptyId: string): void {
    this.repaintWatchByPtyId.get(ptyId)?.stop()
    this.repaintWatchByPtyId.delete(ptyId)
  }
}

function isInLandedRepaintWindow(paste: OwnPasteRecord): boolean {
  return paste.landedAt !== null && Date.now() - paste.landedAt < AGENT_PROMPT_LANDED_REPAINT_MS
}
