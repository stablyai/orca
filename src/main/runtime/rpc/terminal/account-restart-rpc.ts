import type { output } from 'zod'
import type { TerminalCreateParams } from '../../../../shared/rpc-contract/terminal/terminal-unary-params'
import { ACCOUNT_RESTART_OUTCOME_UNKNOWN } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'

type CreateParams = output<typeof TerminalCreateParams>

export function accountRestartCreateDispatch(params: CreateParams, signal?: AbortSignal) {
  if (!params.accountRestart) {
    return {}
  }
  // Exact restart recovery observes the pane snapshot, including for desktop window tabs.
  if (params.reconcileExisting) {
    throw new Error(ACCOUNT_RESTART_OUTCOME_UNKNOWN)
  }
  return { accountRestart: params.accountRestart, signal }
}

export function terminalCreateDeduplicationOptions(params: CreateParams) {
  if (!params.accountRestart) {
    return { wslUserAct: true }
  }
  // Alternate selectors are resolved to the same workspace before the deduplicator compares intent.
  const { worktree: _worktree, clientMutationId: _mutation, ...intent } = params
  return { wslUserAct: true, accountRestart: { ...intent, accountRestart: params.accountRestart } }
}

export function isAccountRestartRpcCall(method: string, params: unknown): boolean {
  return (
    (method === 'terminal.create' || method === 'terminal.ensureAgentSession') &&
    typeof params === 'object' &&
    params !== null &&
    'accountRestart' in params &&
    params.accountRestart !== undefined
  )
}
