/**
 * The one answer to "has the agent Orca just launched opened its composer?", shared by every host
 * path that writes a first input into a fresh agent: `agent.launch`'s terminal prompt and, through
 * `waitForWorkerStartComposer`, an orchestration worker's first dispatch.
 *
 * The signal is the one the desktop's own paste used: bracketed paste turned on (DECSET 2004) plus
 * the agent's `draftPasteReadySignal` (its composer marker, or a quiet render after 2004), read by
 * the shared `draft-paste-ready-scanner`, within the same per-agent budget. That signal cannot tell
 * a composer from a startup dialog drawn in the same mode, so it counts only while the pane shows no
 * startup dialog and no Codex provisional header (`readFreshComposerHold`). Unlike the desktop's
 * paste it reads only output after the shell's last `?2004l`, and drops a signal while a shell is
 * proven in front (`readLaunchedAgentForeground`). A signal is never proof by itself: a shell back
 * at its prompt turns bracketed paste on too, so the write still needs the agent found in front.
 *
 * Where the desktop pasted blind once its budget ran out, the host falls back to the `tui-idle`
 * evidence ranking (idle titles, known ready screens), which also reports a dialog left up. A few
 * agents show readiness only in their composer, which that ranking cannot read: ZCode paints no
 * title and repaints its banner forever, DSH's idle hook fires only after a turn, and Grok's only
 * title is its bare name. They wait for their marker alone.
 */

import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import type { OrcaRuntimeService } from './orca-runtime'
import { showsHoldAnchor } from './agent-state-rules/agent-state-text-anchors'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

/**
 * Agents whose launch readiness is a composer marker pinned by a captured transcript
 * (`zcode-readiness-transcript.test.ts`, `dsh-readiness-transcript.test.ts`,
 * `draft-paste-ready-scanner-grok-trace-replay.test.ts`). Grok is here because its only other
 * evidence is its bare name, which a shell auto-title also writes, and its screen never quiets.
 */
const COMPOSER_MARKER_READINESS_AGENTS: ReadonlySet<TuiAgent> = new Set(['zcode', 'dsh', 'grok'])

/**
 * Composer-marker agents that can also render inline, where the marker's alternate-screen anchor
 * never arrives (`grok-inline-startup-pty-trace.ts`). The quiet window after bracketed paste stays
 * armed for them as the floor, as the desktop's own paste and worktree.create's draft paste use it.
 */
const INLINE_RENDERING_COMPOSER_AGENTS: ReadonlySet<TuiAgent> = new Set(['grok'])

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

/**
 * What keeps a ready signal from counting: a startup dialog in the pane's text or on its screen, or
 * a rule file's hold anchor (Codex 0.157's provisional `model: loading` header, which discards input).
 */
export function readFreshComposerHold(
  waitText: string,
  screenLines: readonly string[] | null
): 'dialog' | 'starting' | null {
  if (
    detectTerminalWaitBlockedReason(waitText) !== null ||
    (screenLines !== null && detectTerminalWaitBlockedReason(screenLines.join('\n')) !== null)
  ) {
    return 'dialog'
  }
  return showsHoldAnchor(waitText.toLowerCase()) ? 'starting' : null
}

/**
 * A fresh orchestration worker's first dispatch. Marker agents wait for their marker, as a launch
 * does; every other agent takes main's cue for this path, `tui-idle`, which settles on the agent's
 * own ready title instead of a quiet window after it. That dispatch waits for the render to settle
 * before Enter, so it never needed the desktop paste's later cue.
 */
export function waitForWorkerStartComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  if (COMPOSER_MARKER_READINESS_AGENTS.has(agent)) {
    return waitForComposerMarker(runtime, handle, agent, timeoutMs)
  }
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs,
    launchReadiness: true
  })
}

function waitForComposerMarker(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  return runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs, {
    requireComposerMarker: !INLINE_RENDERING_COMPOSER_AGENTS.has(agent)
  })
}

/**
 * The composer signal's wait, then — if it did not settle within the desktop paste's budget, or a
 * startup dialog is up — the `tui-idle` wait for what is left of `timeoutMs`, whose result says
 * ready, blocked by a dialog, or not ready. Throws when that runs out too.
 */
export async function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  if (COMPOSER_MARKER_READINESS_AGENTS.has(agent)) {
    return waitForComposerMarker(runtime, handle, agent, timeoutMs)
  }
  const startedAt = Date.now()
  try {
    return await runtime.waitForFreshWorkerComposer(
      handle,
      agent,
      Math.min(timeoutMs, resolveDraftPasteReadyTimeoutMs(agent)),
      { requireComposerMarker: false, stopOnDialog: true }
    )
  } catch {
    // Out of budget, a dialog up, or a pane it could not read: the idle wait answers each, and
    // throws for a handle that is gone.
  }
  // Checked, where the desktop pasted blind: an agent that shows no readiness keeps its text.
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    launchReadiness: true
  })
}
