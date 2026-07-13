import { JsonRpcErrorCode } from '../ssh/relay-protocol'

type SshPtyLivenessOptions = {
  probe: (id: string) => Promise<boolean>
  listIds: () => Promise<string[]>
}

const MAX_LEGACY_MEMBERSHIP_OVERRIDES = 256

export class SshPtyLiveness {
  private supportsTargetedProbe: boolean | undefined
  private targetedProbeInFlight: Promise<boolean> | undefined
  private legacyIds: Set<string> | undefined
  private legacyInventoryInFlight: Promise<Set<string>> | undefined
  private legacyInventoryAcceptsOverrides = false
  private legacyInventoryGeneration = 0
  private legacyMembershipOverrides = new Map<string, boolean>()

  constructor(private readonly options: SshPtyLivenessOptions) {}

  dispose(): void {
    this.targetedProbeInFlight = undefined
    this.legacyInventoryGeneration += 1
    this.legacyIds = undefined
    this.legacyInventoryInFlight = undefined
    this.legacyInventoryAcceptsOverrides = false
    this.legacyMembershipOverrides.clear()
  }

  markLive(id: string): void {
    this.updateLegacyMembership(id, true)
  }

  markStopped(id: string): void {
    this.updateLegacyMembership(id, false)
  }

  async hasPty(id: string): Promise<boolean> {
    if (this.supportsTargetedProbe === false) {
      return (await this.getLegacyIds()).has(id)
    }
    if (this.supportsTargetedProbe === true) {
      return this.options.probe(id)
    }
    if (this.targetedProbeInFlight) {
      await this.targetedProbeInFlight
      return this.hasPty(id)
    }
    const probe = this.probeCapability(id)
    this.targetedProbeInFlight = probe
    try {
      return await probe
    } finally {
      if (this.targetedProbeInFlight === probe) {
        this.targetedProbeInFlight = undefined
      }
    }
  }

  private async probeCapability(id: string): Promise<boolean> {
    try {
      const live = await this.options.probe(id)
      this.supportsTargetedProbe = true
      this.legacyIds = undefined
      return live
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        (error as { code?: unknown }).code !== JsonRpcErrorCode.MethodNotFound
      ) {
        throw error
      }
      // Why: a new desktop may reconnect to a preserved older relay. Cache the
      // narrow protocol miss and one inventory for the multi-PTY stop sequence.
      this.supportsTargetedProbe = false
      return (await this.getLegacyIds()).has(id)
    }
  }

  private updateLegacyMembership(id: string, live: boolean): void {
    if (this.legacyIds) {
      if (live) {
        this.legacyIds.add(id)
      } else {
        this.legacyIds.delete(id)
      }
    } else if (
      this.supportsTargetedProbe === false &&
      this.legacyInventoryInFlight &&
      this.legacyInventoryAcceptsOverrides
    ) {
      // Why: lifecycle changes can settle while the legacy inventory RPC is
      // in flight; replay them onto its result before any liveness read.
      if (
        !this.legacyMembershipOverrides.has(id) &&
        this.legacyMembershipOverrides.size >= MAX_LEGACY_MEMBERSHIP_OVERRIDES
      ) {
        // Why: a corrupt/hostile relay must not grow this transient map without
        // bound. Invalidate the snapshot so no caller trusts dropped updates.
        this.legacyInventoryGeneration += 1
        this.legacyMembershipOverrides.clear()
        this.legacyInventoryAcceptsOverrides = false
        return
      }
      this.legacyMembershipOverrides.set(id, live)
    }
  }

  private async getLegacyIds(): Promise<Set<string>> {
    if (this.legacyIds) {
      return this.legacyIds
    }
    if (this.legacyInventoryInFlight) {
      return this.legacyInventoryInFlight
    }
    const generation = this.legacyInventoryGeneration
    this.legacyInventoryAcceptsOverrides = true
    const inventory = this.options
      .listIds()
      .then((ids) => {
        if (this.legacyInventoryGeneration !== generation) {
          throw new Error('SSH legacy PTY inventory invalidated during liveness updates')
        }
        const liveIds = new Set(ids)
        for (const [id, live] of this.legacyMembershipOverrides) {
          if (live) {
            liveIds.add(id)
          } else {
            liveIds.delete(id)
          }
        }
        this.legacyMembershipOverrides.clear()
        this.legacyIds = liveIds
        return liveIds
      })
      .catch((error) => {
        // Why: a failed/invalidated inventory is not a reusable baseline. Its
        // transient overrides would otherwise accumulate forever across retries.
        this.legacyMembershipOverrides.clear()
        throw error
      })
    this.legacyInventoryInFlight = inventory
    try {
      return await inventory
    } finally {
      if (this.legacyInventoryInFlight === inventory) {
        this.legacyInventoryInFlight = undefined
        this.legacyInventoryAcceptsOverrides = false
        this.legacyMembershipOverrides.clear()
      }
    }
  }
}
