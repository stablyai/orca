import { defineMethod, type RpcAnyMethod } from '../core'
import { TerminalAdoptOrphans } from '../../../../shared/rpc-contract/terminal-orphan-params'

export const TERMINAL_ORPHAN_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.adoptOrphans',
    params: TerminalAdoptOrphans,
    handler: async (params, { runtime }) => runtime.adoptTerminalOrphans(params)
  })
]
