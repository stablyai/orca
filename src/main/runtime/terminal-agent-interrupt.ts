import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { writeFencedAgentKeys } from './terminal-agent-fenced-keys'
import type { TerminalAgentPromptAnswerRuntime } from './terminal-agent-prompt-answer'

// What Claude and Codex read as their interrupt key, as the desktop chat's stop sends it.
const ESCAPE = '\x1b'

export type AgentInterruptOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: 'agent_not_working' | 'agent_not_reachable' }
  | { outcome: 'unknown' }

class AgentNoLongerWorkingError extends Error {
  constructor() {
    super('agent_not_working')
  }
}

/** The host must still report the same process running a main-agent turn at handoff. */
export async function interruptWorkingAgent(
  runtime: TerminalAgentPromptAnswerRuntime,
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null,
  paneKey: string,
  options: {
    /** The caller's own check before the key goes in (its agent-in-front guard). */
    beforeWrite?: (ptyId: string) => Promise<void>
    signal: AbortSignal
  }
): Promise<AgentInterruptOutcome> {
  /** The working turn's process; null once the pane's row stops saying working. Throws unbound. */
  const working = (): { handle: string; ptyId: string; processIncarnation: string } | null => {
    const handle = runtime.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      throw new Error('agent_not_reachable')
    }
    const row = readHookRow(paneKey)
    if (!row) {
      throw new Error('agent_not_reachable')
    }
    // Escape stops only the main agent's turn; background work alone leaves an idle composer.
    if ((row.mainAgent?.state ?? row.state) !== 'working') {
      return null
    }
    const { ptyId, processIncarnation } = runtime.getTerminalPromptRequestBinding(handle)
    return { handle, ptyId, processIncarnation }
  }
  let read: ReturnType<typeof working>
  try {
    read = working()
  } catch {
    return { outcome: 'refused', reason: 'agent_not_reachable' }
  }
  if (!read) {
    return { outcome: 'refused', reason: 'agent_not_working' }
  }
  const turn = read
  const written = await writeFencedAgentKeys(runtime, turn.handle, ESCAPE, {
    signal: options.signal,
    beforeWrite: options.beforeWrite,
    fence: (ptyId) => {
      if (options.signal.aborted) {
        throw new Error('request_aborted')
      }
      // No await separates this host-state check from transport handoff.
      const now = working()
      if (!now) {
        throw new AgentNoLongerWorkingError()
      }
      if (
        ptyId !== turn.ptyId ||
        now.ptyId !== turn.ptyId ||
        now.processIncarnation !== turn.processIncarnation
      ) {
        throw new Error('terminal_handle_stale')
      }
    }
  })
  if (written.outcome !== 'refused') {
    return written
  }
  return {
    outcome: 'refused',
    reason:
      written.error instanceof AgentNoLongerWorkingError
        ? 'agent_not_working'
        : 'agent_not_reachable'
  }
}
