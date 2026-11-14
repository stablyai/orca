import type { TerminalContentOrigin } from '../../../../shared/terminal/output/terminal-content-origin'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  evaluateAgentStateRules,
  readsTrustedScreen
} from '../../agent-state-rules/agent-state-rules-engine'
import type { RuledScreen } from './screen-input-veto'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'

/** Long enough for a renderer's resize repaint and a redraw-interrupted quiet window. */
const RECHECK_WINDOW_MS = 60_000

type ReattachedReadyScreen = { kind: 'idle' } | { kind: 'recheck'; afterMs: number } | null

/** Whether a reattached agent's own strong ready rule holds on its trusted grid. Only agents whose
 *  rules read that grid qualify; a grid not yet readable or a quiet window still owed asks for a
 *  recheck, and anything else (busy, draft, dialog, unknown screen) answers nothing. */
function readReattachedReadyScreen(
  agent: TerminalAgent | null,
  screen: RuledScreen | null,
  outputClockAt: number | null,
  contentScope?: TerminalContentOrigin
): ReattachedReadyScreen {
  if (!isTuiAgent(agent) || !readsTrustedScreen(agent)) {
    return null
  }
  if (!screen) {
    return { kind: 'recheck', afterMs: TUI_IDLE_QUIESCENCE_MS }
  }
  const verdict = evaluateAgentStateRules(agent, {
    readScreenLines: () => screen.lines,
    contentScope
  })
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
  readContentScope?: () => TerminalContentOrigin | undefined
  /** False once a respawn, exit or live status decides instead. */
  isCurrent: () => boolean
  applyIdle: () => void
}

/** Give a reattached agent idle when its ready screen holds, rechecking within a bounded window. */
export function restoreFromReattachedReadyScreen(
  restore: ReattachedReadyScreenRestore,
  recheckUntil = Date.now() + RECHECK_WINDOW_MS
): void {
  const ready = readReattachedReadyScreen(
    restore.agent,
    restore.readScreen(),
    restore.readOutputClockAt(),
    restore.readContentScope?.()
  )
  if (ready?.kind === 'idle') {
    restore.applyIdle()
  } else if (ready?.kind === 'recheck' && Date.now() < recheckUntil) {
    const recheck = (): void => {
      if (restore.isCurrent()) {
        restoreFromReattachedReadyScreen(restore, recheckUntil)
      }
    }
    setTimeout(recheck, ready.afterMs).unref?.()
  }
}
