import type { PtySpawnOptions, PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonRouterRetirement } from './daemon-router-retirement'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { RoutedSurfaceExecution } from '../../../providers/routed-surface-execution'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'

type DaemonRouterSpawnContext = {
  retirement: DaemonRouterRetirement
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
  surfaceExecution: RoutedSurfaceExecution<DaemonPtyAdapter>
  current: DaemonPtyAdapter
  legacy: DaemonPtyAdapter[]
  sessionAdapters: Map<string, DaemonPtyAdapter>
  legacyExitProof: LegacyDaemonExitProof
}

export async function spawnDaemonRouterPty(
  opts: PtySpawnOptions,
  context: DaemonRouterSpawnContext
): Promise<PtySpawnResult> {
  if (context.retirement.admissionClosed) {
    throw new Error('Terminal daemon is decommissioning')
  }
  // Retirement census must account for spawns that have not published their sessions yet.
  context.retirement.spawnInFlight++
  try {
    if (opts.attachOnly && opts.sessionId) {
      return await context.ownerResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
    }
    const selected = opts.surfaceExecution
      ? await context.surfaceExecution.provider(opts.surfaceExecution)
      : null
    if (opts.surfaceExecution && !selected) {
      throw new Error('terminal_executor_unavailable')
    }
    const adapter =
      selected ??
      (opts.sessionId ? context.sessionAdapters.get(opts.sessionId) : undefined) ??
      (await findLegacySessionOwner(opts, context.current, context.legacy, context.legacyExitProof))
    const target = await routeSpawnOrHold(opts, adapter, context.current, context.ownerResolver)
    const result = await target.spawn(opts)
    if (!result.exitedBeforeSpawnReply) {
      context.ownerResolver.recordRoute(result.id, target, result.incarnationId)
    }
    return result
  } finally {
    context.retirement.spawnInFlight--
  }
}
