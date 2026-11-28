import {
  closeOutcome,
  observeTerminals,
  queueTerminalWorkspaceCommand,
  sleepOutcome,
  terminalLostContact
} from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { defineMethod, type RpcContext } from '../../core'
import type { RpcCallerScope } from '../../callers/rpc-caller-scope'
import type { PtyList } from '../../../terminal/records/runtime-terminal-state-records'
import { callerListIn } from '../../../session-tabs/person/person-workspace-target'
import {
  TerminalCloseAll,
  TerminalSleep,
  TerminalStop,
  TerminalStopExact
} from '../../../../../shared/rpc-contract/terminal/terminal-unary-params'

/** The terminals a caller's workspace-wide act takes (`callerListIn`). */
async function callerTerminalList(
  runtime: RpcContext['runtime'],
  worktreeSelector: string,
  scope: RpcCallerScope | undefined
): Promise<PtyList> {
  if (scope?.kind !== 'bot-share') {
    return 'host'
  }
  const worktree = await runtime.showManagedWorktree(worktreeSelector)
  return callerListIn(runtime.bots.list(), worktree.id, scope)
}

/** Stopping every terminal of a workspace; closing and sleeping them wait in its lifecycle queue. */
export const TERMINAL_WORKSPACE_STOP_METHODS = [
  defineMethod({
    name: 'terminal.stop',
    permission: 'workspace',
    share: 'not-shared',
    params: TerminalStop,
    handler: async (params, { runtime, callerScope }) =>
      runtime.stopTerminalsForWorktree(params.worktree, {
        list: await callerTerminalList(runtime, params.worktree, callerScope)
      })
  }),
  defineMethod({
    name: 'terminal.closeAll',
    permission: 'workspace',
    share: 'not-shared',
    params: TerminalCloseAll,
    handler: async (params, { runtime, callerScope }) => {
      const list = await callerTerminalList(runtime, params.worktree, callerScope)
      return queueTerminalWorkspaceCommand(
        runtime,
        params.worktree,
        {
          kind: 'close',
          run: () => runtime.closeTerminalsForWorktree(params.worktree, { list }),
          outcome: closeOutcome,
          lostContact: terminalLostContact,
          observe: observeTerminals(runtime, params.worktree)
        },
        list
      )
    }
  }),
  defineMethod({
    name: 'terminal.sleep',
    permission: 'workspace',
    share: 'not-shared',
    params: TerminalSleep,
    handler: async (params, { runtime, callerScope }) => {
      const list = await callerTerminalList(runtime, params.worktree, callerScope)
      return queueTerminalWorkspaceCommand(
        runtime,
        params.worktree,
        {
          kind: 'sleep',
          run: () => runtime.sleepTerminalsForWorktree(params.worktree, { list }),
          outcome: sleepOutcome,
          lostContact: terminalLostContact,
          observe: observeTerminals(runtime, params.worktree)
        },
        list
      )
    }
  }),
  defineMethod({
    name: 'terminal.stopExact',
    permission: 'workspace',
    share: 'not-shared',
    params: TerminalStopExact,
    handler: async (params, { runtime }) =>
      runtime.stopExactTerminalsForWorktree(params.worktree, params.expectedPtyIds, {
        keepHistory: params.keepHistory,
        targetOnly: params.targetOnly
      })
  })
] as const
