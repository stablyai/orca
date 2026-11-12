import { defineMethod } from '../../core'
import { TerminalInferCodexQuestionSkip } from '../../../../../shared/rpc-contract/terminal-codex-question-params'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'

/** Codex reports no async-question skip, and this host's hook state tracks the question, so a
 *  desktop typing into a remote Codex pane hands the skip keystroke here. */
export const TERMINAL_CODEX_QUESTION_SKIP_METHODS = [
  defineMethod({
    name: 'terminal.inferCodexQuestionSkip',
    permission: 'workspace',
    params: TerminalInferCodexQuestionSkip,
    handler: async (params, { runtime }): Promise<{ applied: boolean }> => {
      const paneKey = runtime.getLiveTerminalPaneKey(params.terminal)
      if (!paneKey) {
        return { applied: false }
      }
      // The skip path fences on the turn prompt alone; the row clock is the host's own.
      const applied = agentHookServer.inferQuestionAnswered({
        paneKey,
        baselineUpdatedAt: 0,
        baselineStateStartedAt: 0,
        baselinePrompt: params.prompt,
        baselineAgentType: 'codex',
        codexSkip: true
      })
      return { applied }
    }
  })
]
