import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
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

type ReattachedReadyScreen = { kind: 'idle' } | { kind: 'recheck'; afterMs: number } | null

/** Whether a reattached agent's own strong ready rule holds on its trusted grid. Only agents whose
 *  rules read that grid qualify; a grid not yet readable or a quiet window still owed asks for a
 *  recheck, and anything else (busy, draft, dialog, unknown screen) answers nothing. */
function readReattachedReadyScreen(
  agent: TuiAgent,
  screen: RuledScreen | null,
  outputClockAt: number | null
): ReattachedReadyScreen {
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
  /** Whether the process has painted since the reattach. A frame retained from before it may be an
   *  earlier program's, so only the current one's own paint speaks for it. */
  hasPaintedSinceReattach: () => boolean
  /** Asks the running program to redraw itself, sending it no input. */
  requestRepaint: () => void
  /** False once a respawn, exit or live status decides instead. */
  isCurrent: () => boolean
  applyIdle: () => void
}

/** Give a reattached agent idle once its own repaint shows its ready screen. A quiet agent is asked
 *  to repaint once; nothing is read until it has painted, and rechecks stop with a bounded window. */
export function restoreFromReattachedReadyScreen(
  restore: ReattachedReadyScreenRestore,
  recheckUntil = Date.now() + RECHECK_WINDOW_MS,
  repaintRequested = false
): void {
  const { agent } = restore
  if (!isTuiAgent(agent) || !readsTrustedScreen(agent)) {
    return
  }
  const recheck = (afterMs: number, requestRepaint = false): void => {
    if (Date.now() >= recheckUntil) {
      return
    }
    setTimeout(() => {
      if (!restore.isCurrent()) {
        return
      }
      if (requestRepaint && !restore.hasPaintedSinceReattach()) {
        restore.requestRepaint()
      }
      restoreFromReattachedReadyScreen(restore, recheckUntil, repaintRequested || requestRepaint)
    }, afterMs).unref?.()
  }
  if (!restore.hasPaintedSinceReattach()) {
    recheck(repaintRequested ? TUI_IDLE_QUIESCENCE_MS : REPAINT_REQUEST_DELAY_MS, !repaintRequested)
    return
  }
  const outputClockAt = restore.readOutputClockAt()
  const ready = readReattachedReadyScreen(agent, restore.readScreen(), outputClockAt)
  if (ready?.kind === 'idle') {
    restore.applyIdle()
  } else if (ready?.kind === 'recheck') {
    recheck(ready.afterMs)
  } else if (outputClockAt !== null && Date.now() - outputClockAt < TUI_IDLE_QUIESCENCE_MS) {
    // A repaint still in progress can read as neither ready nor busy until it settles.
    recheck(TUI_IDLE_QUIESCENCE_MS)
  }
}
