import type { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

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

export const TERMINAL_SEND_SUPERSEDED = 'terminal_send_superseded'

/** Types user text + Enter into an agent pane. The guards run again as
 *  `beforeWrite` because the settled-prompt probe can take a second. */
export async function sendGuardedAgentPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  text: string,
  options?: { requireIdleAgent?: boolean; stillWanted?: () => boolean }
): Promise<void> {
  const assertSendable = (): Promise<void> =>
    assertTerminalAgentSendable({
      runtime,
      handle,
      assertWritable: () => {},
      requireIdleAgent: options?.requireIdleAgent === true
    })
  await assertSendable()
  const beforeWrite = async (): Promise<void> => {
    await assertSendable()
    if (options?.stillWanted?.() === false) {
      throw new Error(TERMINAL_SEND_SUPERSEDED)
    }
  }
  if (await runtime.isTerminalRunningSettledPromptAgent(handle)) {
    await runtime.sendTerminalAgentPrompt(handle, text, { inputKind: 'driving', beforeWrite })
    return
  }
  await runtime.sendTerminal(handle, { text, enter: true }, { inputKind: 'driving', beforeWrite })
}
