import { defineMethod } from '../core'
import { TerminalAdoptOrphans } from '../../../../shared/rpc-contract/terminal-orphan-params'

export const TERMINAL_ORPHAN_METHODS = [
  defineMethod({
    name: 'terminal.adoptOrphans',
    permission: 'workspace',
    params: TerminalAdoptOrphans,
    handler: async (params, { runtime }) => runtime.adoptTerminalOrphans(params)
  })
]
