import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  evaluateAgentStateRules,
  readsTrustedScreen
} from '../../agent-state-rules/agent-state-rules-engine'
import type { RuledScreen } from './screen-input-veto'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'
import type { LaunchedAgentForeground } from './launched-agent-foreground'
import { resolveTerminalTitlePolicyAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'

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
  /** The rest title retained from before the reattach, if any. */
  readRestTitle: () => string | null
  /** A fresh read at the PTY's owner: `agent` when the program in front is that agent itself. */
  confirmForeground: () => Promise<LaunchedAgentForeground>
  /** The pane's record: one rest-title recovery runs per pane however often it is reattached. */
  owner: object
  /** False once a respawn, exit or live status decides instead. */
  isCurrent: () => boolean
  applyIdle: () => void
}

/** At most this many foreground reads per pane recovery; each waits for its own quiet stretch. */
const REST_TITLE_FOREGROUND_READS = 3
/** Panes with a rest-title recovery under way: a second attach of the same pane joins it. */
const restTitleRecoveries = new WeakSet<object>()

/** A quiet agent that reads no screen leaves only its rest title, which may outlive it: a Claude
 *  that exited before the restart leaves `✳` over the shell, and the shell's prompt redraw is paint.
 *  So paint never revives the title; it counts after a quiet stretch since the reattach, when a fresh
 *  foreground read names the title's own agent. Output during a read retries in the next quiet
 *  stretch; a shell in front, or a title, boundary or lifecycle change, ends it; unverifiable hosts
 *  (Windows) keep the input held. */
function restoreFromReattachedRestTitle(
  restore: ReattachedReadyScreenRestore,
  recheckUntil: number
): void {
  const title = restore.readRestTitle()
  if (
    restTitleRecoveries.has(restore.owner) ||
    !title ||
    detectExplicitIdleStatusFromTitle(title) !== 'idle' ||
    resolveTerminalTitlePolicyAgentType(title) !== restore.agent
  ) {
    return
  }
  restTitleRecoveries.add(restore.owner)
  let readsLeft = REST_TITLE_FOREGROUND_READS
  const stillWanted = (): boolean =>
    restore.isCurrent() && restore.readRestTitle() === title && Date.now() < recheckUntil
  const afterQuiet = (): void => {
    const quietAt = (restore.readOutputClockAt() ?? Date.now()) + TUI_IDLE_QUIESCENCE_MS
    setTimeout(check, Math.max(quietAt - Date.now(), 0)).unref?.()
  }
  const finish = (): void => {
    restTitleRecoveries.delete(restore.owner)
  }
  const check = (): void => {
    const outputClockAt = restore.readOutputClockAt()
    if (!stillWanted()) {
      finish()
      return
    }
    if (outputClockAt !== null && Date.now() - outputClockAt < TUI_IDLE_QUIESCENCE_MS) {
      afterQuiet()
      return
    }
    readsLeft -= 1
    void restore
      .confirmForeground()
      .catch(() => 'unknown' as const)
      .then((foreground) => {
        if (!stillWanted() || foreground === 'shell') {
          finish()
        } else if (foreground === 'agent' && restore.readOutputClockAt() === outputClockAt) {
          finish()
          restore.applyIdle()
        } else if (readsLeft > 0) {
          afterQuiet()
        } else {
          finish()
        }
      })
  }
  afterQuiet()
}

/** Give a reattached agent idle once its own repaint shows its ready screen. A quiet agent is asked
 *  to repaint once; nothing is read until it has painted, and rechecks stop with a bounded window. */
export function restoreFromReattachedReadyScreen(
  restore: ReattachedReadyScreenRestore,
  recheckUntil = Date.now() + RECHECK_WINDOW_MS,
  repaintRequested = false
): void {
  const { agent } = restore
  if (!isTuiAgent(agent)) {
    return
  }
  if (!readsTrustedScreen(agent)) {
    restoreFromReattachedRestTitle(restore, recheckUntil)
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
