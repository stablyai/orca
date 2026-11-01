import {
  closeOutcome,
  observeTerminals,
  queueTerminalWorkspaceCommand,
  sleepOutcome,
  terminalLostContact
} from '../../../workspaces/workspace-lifecycle-commands'
import { defineMethod } from '../../core'
import {
  TerminalCloseAll,
  TerminalSleep,
  TerminalStop,
  TerminalStopExact
} from '../../../../../shared/rpc-contract/terminal-unary-params'

/** Stopping every terminal of a workspace; closing and sleeping them wait in its lifecycle queue. */
export const TERMINAL_WORKSPACE_STOP_METHODS = [
  defineMethod({
    name: 'terminal.stop',
    permission: 'workspace',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.closeAll',
    permission: 'workspace',
    params: TerminalCloseAll,
    handler: async (params, { runtime }) =>
      queueTerminalWorkspaceCommand(runtime, params.worktree, {
        kind: 'close',
        run: () => runtime.closeTerminalsForWorktree(params.worktree),
        outcome: closeOutcome,
        lostContact: terminalLostContact,
        observe: observeTerminals(runtime, params.worktree)
      })
  }),
  defineMethod({
    name: 'terminal.sleep',
    permission: 'workspace',
    params: TerminalSleep,
    handler: async (params, { runtime }) =>
      queueTerminalWorkspaceCommand(runtime, params.worktree, {
        kind: 'sleep',
        run: () => runtime.sleepTerminalsForWorktree(params.worktree),
        outcome: sleepOutcome,
        lostContact: terminalLostContact,
        observe: observeTerminals(runtime, params.worktree)
      })
  }),
  defineMethod({
    name: 'terminal.stopExact',
    permission: 'workspace',
    params: TerminalStopExact,
    handler: async (params, { runtime }) =>
      runtime.stopExactTerminalsForWorktree(params.worktree, params.expectedPtyIds, {
        keepHistory: params.keepHistory,
        targetOnly: params.targetOnly
      })
  })
] as const
