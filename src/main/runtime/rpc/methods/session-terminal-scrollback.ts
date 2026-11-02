import { SessionReadTerminalScrollbackParams } from '../../../../shared/rpc-contract/session-terminal-scrollback-params'
import { defineMethod } from '../core'
import { servesWslMovedPaneHistory } from '../../../orcad/orcad-migration-wsl-destination'

// Defined statically so the params catalog types it; registration is gated per host below.
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

const WSL_HOST_ONLY_METHOD_NAMES: ReadonlySet<string> = new Set(
  SESSION_TERMINAL_SCROLLBACK_METHODS.map((method) => method.name)
)

/** Only a WSL host serves moved panes' stored scrollback; every other host answers method-not-found. */
export function withoutMethodsThisHostDoesNotServe<Method extends { name: string }>(
  methods: readonly Method[]
): readonly Method[] {
  return servesWslMovedPaneHistory()
    ? methods
    : methods.filter((method) => !WSL_HOST_ONLY_METHOD_NAMES.has(method.name))
}
