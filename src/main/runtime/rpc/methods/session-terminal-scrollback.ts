import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { defineMethod } from '../core'

export const SESSION_TERMINAL_SCROLLBACK_METHODS = [
  // Gated by session.terminal-scrollback-read.v1: older hosts answer method-not-found.
  defineMethod({
    name: 'session.readTerminalScrollback',
    permission: 'workspace',
    params: SessionReadTerminalScrollbackParams,
    handler: async (params, { runtime }) =>
      runtime.readTerminalScrollbackForClient({ worktree: params.worktree, ref: params.ref })
  })
]
