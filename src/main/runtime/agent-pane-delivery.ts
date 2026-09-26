import type { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import {
  isResetOptionSelected,
  planUsageLimitResetSelection
} from '../../shared/usage-limit-menu-selection'

const ARROW_DOWN = '\u001b[B'
const ARROW_UP = '\u001b[A'

/** How long the CLI gets to repaint the chooser after the arrows land, before
 *  the highlight is read back. */
const MENU_REPAINT_MS = 300

export type AgentPaneTarget = { handle: string; ptyId: string | null }

/** Which pane of a workspace should receive agent-directed text. Prefers a pane
 *  actually running an agent over the active one: a shell tab is often focused
 *  while the agent works next door. */
export async function resolveWorktreeAgentPane(
  runtime: OrcaRuntimeService,
  worktreeId: string
): Promise<AgentPaneTarget | null> {
  const listed = await runtime.listTerminals(worktreeId, undefined, {
    includeVisualLayouts: false
  })
  const candidates = listed.terminals.filter(
    (terminal) => terminal.worktreeId === worktreeId && terminal.connected && terminal.writable
  )
  for (const terminal of candidates) {
    if (await runtime.isTerminalRunningAgent(terminal.handle)) {
      return { handle: terminal.handle, ptyId: terminal.ptyId }
    }
  }
  // No pane advertises an agent. Returning the first writable one anyway lets the
  // send guard make the final call on fresher evidence than this snapshot.
  const fallback = candidates[0]
  return fallback ? { handle: fallback.handle, ptyId: fallback.ptyId } : null
}

/** Types user text + Enter into an agent pane. The guard runs again as
 *  `beforeWrite` because the settled-prompt probe can take a second, inside
 *  which the pane can reach a permission prompt. */
export async function sendGuardedAgentPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  text: string
): Promise<void> {
  const assertSendable = (): Promise<void> =>
    assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
  await assertSendable()
  const beforeWrite = (): Promise<void> => assertSendable()
  if (await runtime.isTerminalRunningSettledPromptAgent(handle)) {
    await runtime.sendTerminalAgentPrompt(handle, text, { beforeWrite })
    return
  }
  await runtime.sendTerminal(handle, { text, enter: true }, { beforeWrite })
}

/**
 * Select "stop and wait for limit to reset" in a live usage-limit chooser.
 *
 * `menuText` is the tail the caller already read to establish that a menu is
 * showing, so the chooser is parsed from exactly the frame that was verified.
 *
 * Position is never assumed. Claude Code orders this menu differently depending
 * on a server-side flag, and one ordering puts a paid option first, so the row
 * is located by label and the highlight is read back before Enter. An uncertain
 * readback returns false, but the arrows sent before it have already moved the
 * highlight.
 */
export async function chooseUsageLimitReset(
  runtime: OrcaRuntimeService,
  ptyId: string,
  handle: string,
  menuText: string
): Promise<boolean> {
  const delta = planUsageLimitResetSelection(menuText)
  if (delta === null) {
    return false
  }
  if (delta !== 0) {
    const arrow = delta > 0 ? ARROW_DOWN : ARROW_UP
    await runtime.sendTerminal(handle, { text: arrow.repeat(Math.abs(delta)) })
    await pauseForRepaint()
    if (!isResetOptionSelected(runtime.getUsageLimitStallSnapshot(ptyId)?.waitText ?? '')) {
      return false
    }
  }
  await runtime.sendTerminal(handle, { enter: true })
  return true
}

function pauseForRepaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, MENU_REPAINT_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })
}
