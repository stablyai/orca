import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import {
  classifyAgentPromptComposerResidue,
  composerNoLongerShowsAgentPromptPaste,
  type AgentPromptComposerResidue,
  type AgentPromptOwnPaste
} from './agent-prompt-composer-residue'
import { waitForAgentPromptDelay, waitForAgentPromptPromise } from './orca-runtime-core'

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

type AgentPromptComposerScreen = {
  writeChain: Promise<void>
  emulator: { getCursorLineContext: () => TerminalCursorContext | null | undefined }
}

/** The runtime state the ledger reads a pane's composer from. */
export type AgentPromptComposerHost = {
  watchComposer: AgentPromptComposerWatch
  getScreen: (ptyId: string) => AgentPromptComposerScreen | undefined
  /** The screen only when it is the whole screen: no provider-restored suffix or hydration. */
  getJudgeableScreen: (ptyId: string) => AgentPromptComposerScreen | null
  getGeneration: (ptyId: string) => number
}

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

  constructor(private readonly host: AgentPromptComposerHost) {}

  async readResidue(
    ptyId: string,
    generation: number,
    pastePayload: string,
    signal?: AbortSignal
  ): Promise<{ residue: AgentPromptComposerResidue; parsedThrough: Promise<void> | null }> {
    const state = this.host.getJudgeableScreen(ptyId)
    if (!state) {
      return { residue: 'none', parsedThrough: null }
    }
    const settleMs = this.settleMsLeft(ptyId, generation)
    if (settleMs > 0) {
      await waitForAgentPromptDelay(settleMs, signal)
    }
    const parsedThrough = state.writeChain
    await waitForAgentPromptPromise(parsedThrough, signal)
    if (this.host.getScreen(ptyId) !== state || this.host.getGeneration(ptyId) !== generation) {
      return { residue: 'none', parsedThrough: null }
    }
    return {
      residue: classifyAgentPromptComposerResidue(
        state.emulator.getCursorLineContext(),
        pastePayload,
        this.getOwnPaste(ptyId, generation)
      ),
      parsedThrough
    }
  }

  /** Synchronous re-read: is the composer still exactly the parked prompt judged before the awaits? */
  isStillParked(
    ptyId: string,
    generation: number,
    pastePayload: string,
    parsedThrough: Promise<void> | null
  ): boolean {
    const state = this.host.getJudgeableScreen(ptyId)
    // Why: a newer write-chain link means PTY output arrived since the read, parsed or not yet.
    if (
      !state ||
      state.writeChain !== parsedThrough ||
      this.host.getGeneration(ptyId) !== generation
    ) {
      return false
    }
    return (
      classifyAgentPromptComposerResidue(
        state.emulator.getCursorLineContext(),
        pastePayload,
        this.getOwnPaste(ptyId, generation)
      ) === 'same-prompt'
    )
  }

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
    const unsubscribe = this.host.watchComposer(ptyId, (context) => {
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
