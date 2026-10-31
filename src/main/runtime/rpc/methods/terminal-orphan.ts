import { defineMethod } from '../core'
import { TerminalAdoptOrphans } from '../../../../shared/rpc-contract/terminal-orphan-params'

export const TERMINAL_ORPHAN_METHODS = [
  defineMethod({
    name: 'terminal.adoptOrphans',
    // Adopting before placement could adopt a PTY the host is about to place itself.
    requires: ['unshownPlacement'],
    permission: 'workspace',
    params: TerminalAdoptOrphans,
    handler: async (params, { runtime }) => runtime.adoptTerminalOrphans(params)
  })
]
