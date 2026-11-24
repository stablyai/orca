import { defineMethod } from '../../core'
import { TerminalRestartAgent } from '../../../../../shared/rpc-contract/terminal/terminal-viewport-schemas-params'
import { getRuntimeDesktopSurface } from '../../../construction/runtime-desktop-surface'
import type {
  PaneAgentRestartReply,
  PaneAgentRestartResult
} from '../../../../../shared/native-chat/agent-presence/pane-agent-restart-contract'

const PANE_AGENT_RESTART_TIMEOUT_MS = 15_000

// The pane's window restarts it in place, as an account switch does, so a phone asks that window.
export const TERMINAL_RESTART_AGENT_METHODS = [
  defineMethod({
    name: 'terminal.restartAgent',
    permission: 'workspace',
    params: TerminalRestartAgent,
    handler: async (params, { runtime }): Promise<{ restart: PaneAgentRestartResult }> => {
      const paneKey = runtime.getLiveTerminalPaneKey(params.terminal)
      if (!paneKey) {
        return { restart: { ok: false, reason: 'pane_unavailable' } }
      }
      let windowId: number
      try {
        windowId = runtime.getAuthoritativeWindowId()
      } catch {
        return { restart: { ok: false, reason: 'pane_unavailable' } }
      }
      const reply = await getRuntimeDesktopSurface().requestRenderer<PaneAgentRestartReply>(
        windowId,
        {
          channel: 'terminal:requestPaneAgentRestart',
          replyChannel: 'terminal:paneAgentRestartReply',
          payload: {
            paneKey,
            mode: params.mode,
            agent: params.agent,
            sessionId: params.sessionId,
            transcriptPath: params.transcriptPath
          },
          timeoutMs: PANE_AGENT_RESTART_TIMEOUT_MS,
          timeoutMessage: 'Agent restart timed out'
        }
      )
      return { restart: reply.result }
    }
  })
]
