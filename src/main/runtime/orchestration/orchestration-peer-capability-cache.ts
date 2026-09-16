import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { BoundedMap } from '../../../shared/bounded-map'
import type { OrcaRuntimeService } from '../orca-runtime'

const DEFAULT_MAX_PEERS = 128

type CapabilityState = {
  runtimeEpoch: string
  supported: boolean
  negativeExpiresAt?: number
}

type StatusCapabilityState = {
  capabilities: Set<RuntimeCapability>
  negativeExpiresAt: number
}

type CapabilityProbe = {
  generation: symbol
  sequence: number
  status: Promise<RuntimeStatus>
}

export type PeerCapabilityDecision = CapabilityState & {
  cached: boolean
}

export class OrchestrationPeerCapabilityCache {
  private readonly states = new Map<string, Map<RuntimeCapability, CapabilityState>>()
  private readonly statusCapabilities = new Map<string, StatusCapabilityState>()
  private readonly probes = new Map<string, CapabilityProbe>()
  private readonly latestEpochs = new Map<string, string>()
  private readonly sequenceCounters = new Map<string, number>()
  private readonly observedSequences = new Map<string, number>()
  private readonly peers: BoundedMap<string, symbol>
  private readonly negativeTtlMs: number
  private readonly now: () => number

  constructor(options: { negativeTtlMs?: number; maxPeers?: number; now?: () => number } = {}) {
    this.negativeTtlMs = options.negativeTtlMs ?? 30_000
    this.now = options.now ?? Date.now
    this.peers = new BoundedMap({
      maxEntries: options.maxPeers ?? DEFAULT_MAX_PEERS,
      onEvict: (_value, peerFingerprint) => this.evictPeer(peerFingerprint)
    })
  }

  async resolve(args: {
    peerFingerprint: string
    expectedRuntimeEpoch: string | null
    capability: RuntimeCapability
    probe: () => Promise<RuntimeStatus>
  }): Promise<PeerCapabilityDecision> {
    return this.resolveAttempt(args, 1)
  }

  private async resolveAttempt(
    args: {
      peerFingerprint: string
      expectedRuntimeEpoch: string | null
      capability: RuntimeCapability
      probe: () => Promise<RuntimeStatus>
    },
    staleRetriesRemaining: number
  ): Promise<PeerCapabilityDecision> {
    const generation = this.touchPeer(args.peerFingerprint)
    const knownEpoch = this.latestEpochs.get(args.peerFingerprint) ?? args.expectedRuntimeEpoch
    const cached = knownEpoch
      ? this.cached(args.peerFingerprint, knownEpoch, args.capability)
      : null
    if (cached) {
      return cached
    }
    const probeKey = this.key(args.peerFingerprint, knownEpoch ?? 'unknown')
    let probe = this.probes.get(probeKey)
    if (!probe) {
      const sequence = this.nextSequence(args.peerFingerprint)
      const status = args.probe().finally(() => {
        const current = this.probes.get(probeKey)
        if (current?.generation === generation && current.sequence === sequence) {
          this.probes.delete(probeKey)
        }
      })
      probe = { generation, sequence, status }
      this.probes.set(probeKey, probe)
    }
    const status = await probe.status
    const supported = status.capabilities?.includes(args.capability) === true
    if (
      !this.observeEpochAt(args.peerFingerprint, status.runtimeId, probe.sequence, probe.generation)
    ) {
      const latestEpoch = this.latestEpochs.get(args.peerFingerprint)
      const latest = latestEpoch
        ? this.cached(args.peerFingerprint, latestEpoch, args.capability)
        : null
      if (latest) {
        return latest
      }
      if (staleRetriesRemaining > 0) {
        return this.resolveAttempt(
          { ...args, expectedRuntimeEpoch: latestEpoch ?? args.expectedRuntimeEpoch },
          staleRetriesRemaining - 1
        )
      }
      throw new Error('Peer runtime changed repeatedly during capability negotiation')
    }
    this.statusCapabilities.set(this.key(args.peerFingerprint, status.runtimeId), {
      capabilities: new Set(status.capabilities ?? []),
      negativeExpiresAt: this.now() + this.negativeTtlMs
    })
    this.store(args.peerFingerprint, status.runtimeId, args.capability, supported)
    return { runtimeEpoch: status.runtimeId, supported, cached: false }
  }

  /**
   * What the peer's own answers proved, or null when nothing has. Deliberately ignores the
   * advertised capability list: shipped hosts serve federation methods they never advertise, so
   * only a real `method_not_found` may downgrade one.
   */
  knownSupport(
    peerFingerprint: string,
    expectedRuntimeEpoch: string | null,
    capability: RuntimeCapability
  ): PeerCapabilityDecision | null {
    const epoch = this.latestEpochs.get(peerFingerprint) ?? expectedRuntimeEpoch
    const state = epoch ? this.states.get(this.key(peerFingerprint, epoch))?.get(capability) : null
    if (!state || (!state.supported && (state.negativeExpiresAt ?? 0) <= this.now())) {
      return null
    }
    return { runtimeEpoch: state.runtimeEpoch, supported: state.supported, cached: true }
  }

  remember(
    peerFingerprint: string,
    runtimeEpoch: string,
    capability: RuntimeCapability,
    supported: boolean,
    expectedRuntimeEpoch?: string | null
  ): void {
    const latestEpoch = this.latestEpochs.get(peerFingerprint)
    // Advance only from the epoch this call targeted; late answers cannot replace a newer epoch.
    if (
      latestEpoch !== undefined &&
      latestEpoch !== runtimeEpoch &&
      latestEpoch !== expectedRuntimeEpoch
    ) {
      return
    }
    const generation = this.touchPeer(peerFingerprint)
    this.observeEpochAt(
      peerFingerprint,
      runtimeEpoch,
      this.nextSequence(peerFingerprint),
      generation
    )
    this.store(peerFingerprint, runtimeEpoch, capability, supported)
  }

  private store(
    peerFingerprint: string,
    runtimeEpoch: string,
    capability: RuntimeCapability,
    supported: boolean
  ): void {
    const key = this.key(peerFingerprint, runtimeEpoch)
    let states = this.states.get(key)
    if (!states) {
      states = new Map()
      this.states.set(key, states)
    }
    states.set(capability, {
      runtimeEpoch,
      supported,
      ...(supported ? {} : { negativeExpiresAt: this.now() + this.negativeTtlMs })
    })
  }

  observeEpoch(peerFingerprint: string, runtimeEpoch: string): void {
    const generation = this.touchPeer(peerFingerprint)
    this.observeEpochAt(
      peerFingerprint,
      runtimeEpoch,
      this.nextSequence(peerFingerprint),
      generation
    )
  }

  private observeEpochAt(
    peerFingerprint: string,
    runtimeEpoch: string,
    sequence: number,
    generation: symbol
  ): boolean {
    if (this.peers.peek(peerFingerprint) !== generation) {
      return false
    }
    const observedSequence = this.observedSequences.get(peerFingerprint) ?? 0
    if (sequence < observedSequence) {
      return false
    }
    this.observedSequences.set(peerFingerprint, sequence)
    const previous = this.latestEpochs.get(peerFingerprint)
    if (previous === runtimeEpoch) {
      return true
    }
    this.latestEpochs.set(peerFingerprint, runtimeEpoch)
    if (previous) {
      this.states.delete(this.key(peerFingerprint, previous))
      this.statusCapabilities.delete(this.key(peerFingerprint, previous))
    }
    return true
  }

  private cached(
    peerFingerprint: string,
    runtimeEpoch: string,
    capability: RuntimeCapability
  ): PeerCapabilityDecision | null {
    const state = this.states.get(this.key(peerFingerprint, runtimeEpoch))?.get(capability)
    if (state) {
      if (state.supported || (state.negativeExpiresAt ?? 0) > this.now()) {
        return { runtimeEpoch: state.runtimeEpoch, supported: state.supported, cached: true }
      }
      this.states.get(this.key(peerFingerprint, runtimeEpoch))?.delete(capability)
    }
    const status = this.statusCapabilities.get(this.key(peerFingerprint, runtimeEpoch))
    if (!status) {
      return null
    }
    if (status.capabilities.has(capability)) {
      return { runtimeEpoch, supported: true, cached: true }
    }
    return status.negativeExpiresAt > this.now()
      ? { runtimeEpoch, supported: false, cached: true }
      : null
  }

  private nextSequence(peerFingerprint: string): number {
    const sequence = (this.sequenceCounters.get(peerFingerprint) ?? 0) + 1
    this.sequenceCounters.set(peerFingerprint, sequence)
    return sequence
  }

  private key(peerFingerprint: string, runtimeEpoch: string): string {
    return `${peerFingerprint}\u0000${runtimeEpoch}`
  }

  private touchPeer(peerFingerprint: string): symbol {
    const retainedGeneration = this.peers.get(peerFingerprint)
    if (retainedGeneration !== undefined) {
      return retainedGeneration
    }
    const generation = Symbol(peerFingerprint)
    this.peers.set(peerFingerprint, generation)
    return generation
  }

  private evictPeer(peerFingerprint: string): void {
    this.latestEpochs.delete(peerFingerprint)
    this.sequenceCounters.delete(peerFingerprint)
    this.observedSequences.delete(peerFingerprint)
    const prefix = `${peerFingerprint}\u0000`
    for (const collection of [this.states, this.statusCapabilities, this.probes]) {
      for (const key of collection.keys()) {
        if (key.startsWith(prefix)) {
          collection.delete(key)
        }
      }
    }
  }
}

const cachesByRuntime = new WeakMap<OrcaRuntimeService, OrchestrationPeerCapabilityCache>()

export function getOrchestrationPeerCapabilityCache(
  runtime: OrcaRuntimeService
): OrchestrationPeerCapabilityCache {
  let cache = cachesByRuntime.get(runtime)
  if (!cache) {
    cache = new OrchestrationPeerCapabilityCache()
    cachesByRuntime.set(runtime, cache)
  }
  return cache
}
