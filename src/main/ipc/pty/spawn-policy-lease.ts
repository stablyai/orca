import { runAsWslLaunchUserAct } from '../../wsl/discovery/wsl-background-exec-gate'
import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { PtySpawnOperationState } from './spawn-operation-state'

export async function acquirePtySpawnPolicyLease(
  ctx: PtySpawnOperationState,
  args: PtySpawnOperationState['args'],
  freshReplacement: boolean
): Promise<void> {
  const runtime = ctx.deps.runtime
  const acquire = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquire
    ? await runAsWslLaunchUserAct(
        {
          isWsl: Boolean(ctx.expectedWslDistro),
          distro: ctx.expectedWslDistro,
          passiveRestore:
            ctx.spawnOptions.wslPassiveRestore === true ||
            ctx.spawnOptions.wslBackgroundStart === true
        },
        () =>
          acquire.call(runtime, spawnWorktreeTarget(args.worktreeId, args.connectionId), {
            refuseSleptWorktree: args.refuseSleptWorktree,
            reattachSessionId:
              (freshReplacement ? undefined : ctx.preAdoptedStablePane?.owner.ptyId) ??
              (freshReplacement || ctx.ownsNewIncarnation || args.isNewSession
                ? undefined
                : args.sessionId),
            requireAttachOnly: () => {
              ctx.spawnOptions = { ...ctx.spawnOptions, attachOnly: true }
            }
          })
      )
    : undefined
}
