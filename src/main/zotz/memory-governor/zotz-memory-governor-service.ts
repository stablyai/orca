import type { HostMemory } from '../../../shared/diagnostics/process-stats-types'
import {
  recordZotzAgentPeak,
  type ZotzAgentMemoryLedger
} from '../../../shared/zotz/agent-queue/zotz-agent-memory-ledger'
import type { ZotzMemoryGovernorLimits } from '../../../shared/zotz/agent-queue/zotz-memory-governor-defaults'
import {
  strongerZotzMemoryPressure,
  zotzMemoryPressure,
  type ZotzMemoryPressure
} from '../../../shared/zotz/agent-queue/zotz-memory-pressure'
import type {
  ZotzAgentMemorySampler,
  ZotzAgentMemoryUsage,
  ZotzFinishedAgentRun
} from './zotz-agent-memory-sampler'

/** What the governor knows about the machine right now; the board and the scheduler read this. */
export type ZotzMemoryGovernorState = {
  totalBytes: number
  availableBytes: number
  pressure: ZotzMemoryPressure
  limits: ZotzMemoryGovernorLimits
  agents: ZotzAgentMemoryUsage[]
  /** The latest finished runs, newest first; the board's Done column. */
  finished: ZotzFinishedAgentRun[]
  sampledAt: number
}

type ZotzMemoryGovernorDeps = {
  sampler: ZotzAgentMemorySampler
  collectHost: () => Promise<HostMemory>
  /** What the OS reports beyond free memory (macOS: kernel level, swap growth). */
  readSystemPressure?: () => Promise<ZotzMemoryPressure>
  limits: ZotzMemoryGovernorLimits
  loadLedger: () => Promise<ZotzAgentMemoryLedger>
  saveLedger: (ledger: ZotzAgentMemoryLedger) => Promise<void>
  now: () => number
}

// Agent trees on Windows are measured through PowerShell, so a tighter cadence costs real CPU.
const SAMPLE_INTERVAL_MS = 15_000
const FINISHED_RUNS_KEPT = 20

/**
 * Samples only while agents run and stops when none are left; agent activity wakes it again,
 * so an idle node spends nothing on monitoring.
 */
export class ZotzMemoryGovernorService {
  private ledger: ZotzAgentMemoryLedger = {}
  private state: ZotzMemoryGovernorState | null = null
  private finished: ZotzFinishedAgentRun[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private sampling = false
  private disposed = false
  private readonly listeners = new Set<(state: ZotzMemoryGovernorState) => void>()
  // Queued launches keep sampling alive: memory freed by other apps can let them in.
  private hasWaitingDemand: () => boolean = () => false

  constructor(private readonly deps: ZotzMemoryGovernorDeps) {}

  async start(): Promise<void> {
    this.ledger = await this.deps.loadLedger()
    this.wake()
  }

  setWaitingDemand(hasWaitingDemand: () => boolean): void {
    this.hasWaitingDemand = hasWaitingDemand
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
      const [host, sample, systemPressure] = await Promise.all([
        this.deps.collectHost(),
        this.deps.sampler.sample(),
        this.deps.readSystemPressure?.() ?? Promise.resolve<ZotzMemoryPressure>('ok')
      ])
      if (sample.finished.length > 0) {
        for (const run of sample.finished) {
          this.ledger = recordZotzAgentPeak(this.ledger, run.agent, run.peakBytes)
        }
        this.finished = [...sample.finished.toReversed(), ...this.finished].slice(
          0,
          FINISHED_RUNS_KEPT
        )
        void this.deps.saveLedger(this.ledger).catch((error) => {
          console.warn('[zotz-memory] could not save the agent memory ledger', error)
        })
      }
      this.state = {
        totalBytes: host.totalMemory,
        availableBytes: host.availableMemory,
        pressure: strongerZotzMemoryPressure(
          zotzMemoryPressure({
            availableBytes: host.availableMemory,
            totalBytes: host.totalMemory,
            minFreeBytes: this.deps.limits.minFreeBytes
          }),
          systemPressure
        ),
        limits: this.deps.limits,
        agents: sample.agents,
        finished: this.finished,
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
    if (!this.disposed && (this.deps.sampler.hasLiveAgents() || this.hasWaitingDemand())) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.sampleOnce()
      }, SAMPLE_INTERVAL_MS)
      this.timer.unref?.()
    }
  }
}
