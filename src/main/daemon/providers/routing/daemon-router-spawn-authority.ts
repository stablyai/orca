import {
  acquireProspectivePtySpawn,
  validateProspectivePtySpawn
} from '../../../pty/prospective-pty-spawn'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import type { DaemonRouterRetirement } from './daemon-router-retirement'
import { findLegacySessionOwner } from './daemon-router-legacy-owner'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
export class DaemonRouterSpawnAuthority {
  private closed = false
  constructor(
    private readonly owner: IPtyProvider,
    private readonly current: DaemonPtyAdapter,
    private readonly legacy: DaemonPtyAdapter[],
    private readonly sessionAdapters: Map<string, DaemonPtyAdapter>,
    private readonly legacyExitProof: LegacyDaemonExitProof,
    private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
    private readonly retirement: DaemonRouterRetirement
  ) {}
  close(): void {
    this.closed = true
  }
  private async spawnTarget(opts: PtySpawnOptions): Promise<DaemonPtyAdapter> {
    const adapter =
      (opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined) ??
      (await findLegacySessionOwner(opts, this.current, this.legacy, this.legacyExitProof))
    return await routeSpawnOrHold(opts, adapter, this.current, this.ownerResolver)
  }

  async admit(opts: PtySpawnOptions) {
    if (this.closed || this.retirement.admissionClosed) {
      return null
    }
    this.retirement.spawnInFlight++
    let held = true
    const release = () => {
      if (held) {
        held = false
        this.retirement.spawnInFlight--
      }
    }
    try {
      const target = await this.spawnTarget(opts)
      const heldForNewer = isHoldingForNewerProtocolDaemon()
      const legacy = [...this.legacy]
      const mapped = opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined
      const nested = await acquireProspectivePtySpawn(target, opts)
      if (!nested) {
        release()
        return null
      }
      return {
        target,
        nested,
        currentSync: () =>
          held &&
          !this.closed &&
          !this.retirement.admissionClosed &&
          nested.currentSync() &&
          isHoldingForNewerProtocolDaemon() === heldForNewer &&
          this.legacy.length === legacy.length &&
          this.legacy.every((adapter, index) => adapter === legacy[index]) &&
          (opts.sessionId ? this.sessionAdapters.get(opts.sessionId) : undefined) === mapped,
        current: async () =>
          held &&
          !this.closed &&
          !this.retirement.admissionClosed &&
          (await nested.current()) &&
          (await this.spawnTarget(opts)) === target,
        release: () => {
          nested.release()
          release()
        }
      }
    } catch {
      release()
      return null
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (this.closed || this.retirement.admissionClosed) {
      throw new Error('Terminal daemon is decommissioning')
    }
    // Retirement census must account for spawns that have not published their sessions yet.
    this.retirement.spawnInFlight++
    try {
      if (opts.attachOnly && opts.sessionId) {
        return await this.ownerResolver.spawnAttachOnly({ ...opts, sessionId: opts.sessionId })
      }
      const admission = await validateProspectivePtySpawn(this.owner, opts)
      const target = await this.spawnTarget(opts)
      if (admission?.target && admission.target !== target) {
        throw new Error('Terminal spawn target changed')
      }
      const result = await target.spawn(opts)
      if (!result.exitedBeforeSpawnReply) {
        this.ownerResolver.recordRoute(result.id, target, result.incarnationId)
      }
      return result
    } finally {
      this.retirement.spawnInFlight--
    }
  }
}
