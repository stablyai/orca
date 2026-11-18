import type { HostMemory } from '../../../shared/diagnostics/process-stats-types'
import {
  recordZotzAgentPeak,
  type ZotzAgentMemoryLedger
} from '../../../shared/zotz/agent-queue/zotz-agent-memory-ledger'
import type { ZotzMemoryGovernorLimits } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import {
  zotzMemoryPressure,
  type ZotzMemoryPressure
} from '../../../shared/zotz/agent-queue/zotz-memory-pressure'
import type { ZotzAgentMemorySampler, ZotzAgentMemoryUsage } from './zotz-agent-memory-sampler'

/** What the governor knows about the machine right now; the board and the scheduler read this. */
export type ZotzMemoryGovernorState = {
  totalBytes: number
  availableBytes: number
  pressure: ZotzMemoryPressure
  limits: ZotzMemoryGovernorLimits
  agents: ZotzAgentMemoryUsage[]
  sampledAt: number
}

type ZotzMemoryGovernorDeps = {
  sampler: ZotzAgentMemorySampler
  collectHost: () => Promise<HostMemory>
  limits: ZotzMemoryGovernorLimits
  loadLedger: () => Promise<ZotzAgentMemoryLedger>
  saveLedger: (ledger: ZotzAgentMemoryLedger) => Promise<void>
  now: () => number
}

// Agent trees on Windows are measured through PowerShell, so a tighter cadence costs real CPU.
const SAMPLE_INTERVAL_MS = 15_000

/**
 * Samples only while agents run and stops when none are left; agent activity wakes it again,
 * so an idle node spends nothing on monitoring.
 */
export class ZotzMemoryGovernorService {
  private ledger: ZotzAgentMemoryLedger = {}
  private state: ZotzMemoryGovernorState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private sampling = false
  private disposed = false
  private readonly listeners = new Set<(state: ZotzMemoryGovernorState) => void>()

  constructor(private readonly deps: ZotzMemoryGovernorDeps) {}

  async start(): Promise<void> {
    this.ledger = await this.deps.loadLedger()
    this.wake()
  }

  getState(): ZotzMemoryGovernorState | null {
    return this.state
  }

  getLedger(): ZotzAgentMemoryLedger {
    return this.ledger
  }

  subscribe(listener: (state: ZotzMemoryGovernorState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Samples now unless a sample is already scheduled or running. */
  wake(): void {
    if (this.disposed || this.sampling || this.timer) {
      return
    }
    void this.sampleOnce()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.listeners.clear()
  }

  private async sampleOnce(): Promise<void> {
    this.sampling = true
    try {
      const [host, sample] = await Promise.all([
        this.deps.collectHost(),
        this.deps.sampler.sample()
      ])
      if (sample.finished.length > 0) {
        for (const run of sample.finished) {
          this.ledger = recordZotzAgentPeak(this.ledger, run.agent, run.peakBytes)
        }
        void this.deps.saveLedger(this.ledger).catch((error) => {
          console.warn('[zotz-memory] could not save the agent memory ledger', error)
        })
      }
      this.state = {
        totalBytes: host.totalMemory,
        availableBytes: host.availableMemory,
        pressure: zotzMemoryPressure({
          availableBytes: host.availableMemory,
          totalBytes: host.totalMemory,
          minFreeBytes: this.deps.limits.minFreeBytes
        }),
        limits: this.deps.limits,
        agents: sample.agents,
        sampledAt: this.deps.now()
      }
      for (const listener of this.listeners) {
        listener(this.state)
      }
    } catch (error) {
      console.warn('[zotz-memory] sample failed', error)
    } finally {
      this.sampling = false
    }
    if (!this.disposed && this.deps.sampler.hasLiveAgents()) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.sampleOnce()
      }, SAMPLE_INTERVAL_MS)
      this.timer.unref?.()
    }
  }
}
