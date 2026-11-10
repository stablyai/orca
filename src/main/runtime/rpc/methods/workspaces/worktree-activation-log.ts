import type { RpcContext } from '../../core'

/** Records who woke a worktree; ids only, never the bearer-token clientId. */
export function logWorktreeActivation(
  worktree: string,
  caller: Pick<RpcContext, 'clientKind' | 'pairedDeviceId' | 'caller'>
): void {
  console.log(
    `[runtime] worktree.activate: worktree=${JSON.stringify(worktree)} device=${caller.pairedDeviceId ?? 'none'} kind=${caller.clientKind ?? 'in-process'} caller=${caller.caller?.kind ?? 'unknown'}`
  )
}
