import type { PtySpawnOptions } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import { dropLegacyAdapter } from './daemon-router-exited-legacy'
import {
  DaemonRouterLegacyIdleRetirement,
  type LegacyIdleRetirementOptions
} from './daemon-router-legacy-idle-retirement'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import type { DaemonRouterRetirement } from './daemon-router-retirement'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

type RouterSpawnState = {
  current: () => DaemonPtyAdapter
  legacy: DaemonPtyAdapter[]
  sessionAdapters: ReadonlyMap<string, DaemonPtyAdapter>
  retirement: DaemonRouterRetirement
  exitProof: LegacyDaemonExitProof
  ownerResolver: () => DaemonSessionOwnerResolver<DaemonPtyAdapter>
  subscriptions: () => DaemonPtyAdapterSubscriptionFanout
  legacyIdleRetirementTiming: LegacyIdleRetirementOptions['timing'] | undefined
}

/** Routes spawns across generations and retires older ones once they own nothing. */
export class DaemonRouterSpawn {
  readonly legacyIdle: DaemonRouterLegacyIdleRetirement

  constructor(private readonly state: RouterSpawnState) {
    this.legacyIdle = new DaemonRouterLegacyIdleRetirement({
      current: state.current,
      legacy: () => state.legacy,
      drop: (adapter) => {
        if (dropLegacyAdapter(adapter, state.legacy, state.subscriptions())) {
          state.ownerResolver().forgetProvider(adapter)
        }
      },
      ...(state.legacyIdleRetirementTiming ? { timing: state.legacyIdleRetirementTiming } : {})
    })
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    try {
      return await this.spawnOnce(opts)
    } catch (error) {
      // An older generation that retired under this spawn owned nothing; route again without it.
      if (!(await this.legacyIdle.settleHeldRetirements(error))) {
        throw error
      }
      return await this.spawnOnce(opts)
    }
  }

  private async spawnOnce(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const { retirement, sessionAdapters } = this.state
    // Only a known or routed session can reach an older generation; other fresh ones start on current.
    const mayReachLegacy =
      opts.sessionId !== undefined && (!opts.isNewSession || sessionAdapters.has(opts.sessionId))
    const releaseReattach = mayReachLegacy ? await this.legacyIdle.admitReattach() : null
    if (retirement.admissionClosed) {
      releaseReattach?.()
      throw new Error('Terminal daemon is decommissioning')
    }
    // Retirement census must account for spawns that have not published their sessions yet.
    retirement.spawnInFlight++
    try {
      const ownerResolver = this.state.ownerResolver()
      if (opts.attachOnly && opts.sessionId) {
        return await ownerResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
      }
      const current = this.state.current()
      const adapter =
        (opts.sessionId ? sessionAdapters.get(opts.sessionId) : undefined) ??
        (await findLegacySessionOwner(opts, current, this.state.legacy, this.state.exitProof))
      const target = await routeSpawnOrHold(opts, adapter, current, ownerResolver)
      const result = await target.spawn(opts)
      if (!result.exitedBeforeSpawnReply) {
        ownerResolver.recordRoute(result.id, target, result.incarnationId)
      }
      return result
    } finally {
      retirement.spawnInFlight--
      releaseReattach?.()
    }
  }
}
