import { toAppWslPtyId, toRelayWslPtyId } from '../../../../shared/wsl-pty-id'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import { prepareWslDaemonSpawnRoute } from '../../../wsl/wsl-daemon-spawn-route'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcWslRoute(ctx: PtyIpcSpawnState): Promise<void> {
  if (ctx.preAdoptedStablePane) {
    return
  }
  const route = await prepareWslDaemonSpawnRoute({
    sessions: ctx.deps.options?.wslDaemonSessions,
    connectionId: ctx.args.connectionId,
    sessionId: ctx.args.sessionId,
    distro: ctx.expectedWslDistro
  })
  if (!route) {
    return
  }
  ctx.wslGuest = route
  ctx.provider = route.connection.provider
  ctx.expectedWslDistro = route.connection.owner.distro
  ctx.isDaemonHostSpawn = true
  ctx.isMintedSessionId = route.fresh
  ctx.effectiveSessionId = route.fresh
    ? (ctx.effectiveSessionId ?? mintPtySessionId(ctx.args.worktreeId))
    : toRelayWslPtyId(route.connection.owner, ctx.args.sessionId!)
  ctx.effectiveSessionAppId = toAppWslPtyId(route.connection.owner, ctx.effectiveSessionId)
  ctx.effectiveSessionRelayId = ctx.effectiveSessionId
  const previousHidden = ctx.preSpawnHiddenMarkId
  ctx.preSpawnHiddenMarkId = ctx.initiallyHidden ? ctx.effectiveSessionAppId : null
  if (previousHidden !== ctx.preSpawnHiddenMarkId) {
    if (previousHidden) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(previousHidden, false)
    }
    if (ctx.preSpawnHiddenMarkId) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
    }
  }
}
