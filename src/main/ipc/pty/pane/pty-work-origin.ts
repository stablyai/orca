import type { RuntimePtySpawnState } from '../runtime/spawn-state'
import { normalizeWorkOrigin, type WorkOrigin } from '../../../../shared/work-origin'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'

export function resolvePtySpawnWorkOrigin(
  args: { workOrigin?: WorkOrigin; tabId?: string; leafId?: string; connectionId?: string | null },
  store: Store | undefined
): WorkOrigin {
  if (args.workOrigin !== undefined) {
    return normalizeWorkOrigin(args.workOrigin) ?? null
  }
  const session =
    args.tabId && args.leafId
      ? store?.getWorkspaceSession(
          args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
        )
      : undefined
  const retained =
    args.tabId && args.leafId
      ? session?.terminalWorkOriginsByPaneKey?.[`${args.tabId}:${args.leafId}`]
      : undefined
  return retained === undefined ? { kind: 'host' } : retained
}

export function resolveCommittedPtyWorkOrigin(ctx: RuntimePtySpawnState): WorkOrigin | undefined {
  return ctx.result.isReattach ||
    ctx.stablePaneOwner ||
    ctx.result.agentSessionEnsure?.disposition === 'adopted'
    ? ctx.result.workOrigin
    : ctx.spawnOptions.workOrigin
}
