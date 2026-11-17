import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { TERMINAL_VIEWPORT_MIN_ROWS } from '../../../../shared/terminal/viewport/terminal-viewport'
import {
  evaluateAgentStateRules,
  readsTrustedScreen
} from '../../agent-state-rules/agent-state-rules-engine'
import type { RuledScreen } from './screen-input-veto'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'

/** Long enough for a renderer's resize repaint and a redraw-interrupted quiet window. */
const RECHECK_WINDOW_MS = 60_000
// Why a delay: a renderer that fits a different grid on attach already makes the program repaint.
const REPAINT_REQUEST_DELAY_MS = 1_000
// Why: two distinct sizes, held long enough for the program to see both and redraw.
const REPAINT_RESTORE_MS = 250

type ReattachedReadyScreen = { kind: 'idle' } | { kind: 'recheck'; afterMs: number } | null

/** Whether a reattached agent's own strong ready rule holds on its trusted grid. Only agents whose
 *  rules read that grid qualify; a grid not yet readable or a quiet window still owed asks for a
 *  recheck, and anything else (busy, draft, dialog, unknown screen) answers nothing. */
function readReattachedReadyScreen(
  agent: TerminalAgent | null,
  screen: RuledScreen | null,
  outputClockAt: number | null
): ReattachedReadyScreen {
  if (!isTuiAgent(agent) || !readsTrustedScreen(agent)) {
    return null
  }
  if (!screen) {
    return { kind: 'recheck', afterMs: TUI_IDLE_QUIESCENCE_MS }
  }
  const verdict = evaluateAgentStateRules(agent, { readScreenLines: () => screen.lines })
  if (verdict?.state !== 'idle' || verdict.strength !== 'strong') {
    return null
  }
  const quietRemainingMs =
    outputClockAt === null
      ? TUI_IDLE_QUIESCENCE_MS
      : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputClockAt)
  return !verdict.requiresQuiet || quietRemainingMs <= 0
    ? { kind: 'idle' }
    : { kind: 'recheck', afterMs: quietRemainingMs + 50 }
}

export type ReattachedReadyScreenRestore = {
  agent: TerminalAgent
  readScreen: () => RuledScreen | null
  readOutputClockAt: () => number | null
  /** Whether the process has written since the reattach. A frame retained from before it may be an
   *  earlier program's, so only the current one's own paint speaks for it. */
  hasOutputSinceReattach: () => boolean
  /** Asks the running program to redraw itself, sending it no input. */
  requestRepaint: () => void
  /** False once a respawn, exit or live status decides instead. */
  isCurrent: () => boolean
  applyIdle: () => void
}

/** Give a reattached agent idle once its own repaint shows its ready screen, asking for that repaint
 *  once when it stays quiet, and rechecking within a bounded window. */
export function restoreFromReattachedReadyScreen(
  restore: ReattachedReadyScreenRestore,
  recheckUntil = Date.now() + RECHECK_WINDOW_MS,
  repaintRequested = false
): void {
  const ready = readReattachedReadyScreen(
    restore.agent,
    restore.readScreen(),
    restore.readOutputClockAt()
  )
  if (ready?.kind === 'idle' && restore.hasOutputSinceReattach()) {
    restore.applyIdle()
    return
  }
  if (!ready || Date.now() >= recheckUntil) {
    return
  }
  const recheck = (afterMs: number, requestRepaint: boolean): void => {
    setTimeout(() => {
      if (!restore.isCurrent()) {
        return
      }
      if (requestRepaint && !restore.hasOutputSinceReattach()) {
        restore.requestRepaint()
      }
      restoreFromReattachedReadyScreen(restore, recheckUntil, repaintRequested || requestRepaint)
    }, afterMs).unref?.()
  }
  if (ready.kind === 'recheck') {
    recheck(ready.afterMs, false)
  } else if (!repaintRequested) {
    recheck(REPAINT_REQUEST_DELAY_MS, true)
  } else {
    recheck(TUI_IDLE_QUIESCENCE_MS, false)
  }
}

type RepaintTarget = {
  getSize: () => { cols: number; rows: number } | null
  resize: (cols: number, rows: number) => boolean
}

/** One row smaller and back: a same-size resize sends no SIGWINCH, two distinct sizes do. */
export function requestProgramRepaint(target: RepaintTarget): void {
  const size = target.getSize()
  if (!size || size.cols < 1 || size.rows < 1) {
    return
  }
  const { cols, rows } = size
  const nudgeRows = rows > TERMINAL_VIEWPORT_MIN_ROWS ? rows - 1 : rows + 1
  try {
    if (!target.resize(cols, nudgeRows)) {
      return
    }
  } catch {
    return
  }
  setTimeout(() => {
    const current = target.getSize()
    // A resize that landed meanwhile owns the grid now.
    if (current?.cols !== cols || current.rows !== nudgeRows) {
      return
    }
    try {
      target.resize(cols, rows)
    } catch {
      // The PTY may have exited during the nudge.
    }
  }, REPAINT_RESTORE_MS).unref?.()
}
