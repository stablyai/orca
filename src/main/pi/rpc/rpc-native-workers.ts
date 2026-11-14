import { createHash } from 'node:crypto'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { PI_BACKGROUND_WORK_STATUS_KEY } from './background-work/rpc-background-work-bridge-source'
import { PI_NATIVE_WORKERS_STATUS_KEY } from './background-work/rpc-native-workers-bridge-source'
import type { StructuredAgentSessionChildWorkProducer } from '../../native-chat/agent-session-wire/observations/structured-agent-session-subagent-rows'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

export type PiRpcNativeWorkersDeps = {
  onChildWorkEvidence?: (
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    producer?: StructuredAgentSessionChildWorkProducer
  ) => void
}
const MAX_SNAPSHOT_BYTES = 64 * 1024

type Worker = { id: string; name: string; description: string }

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 512
    ? Array.from(value, (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char
      )
        .join('')
        .trim()
    : undefined
}

/** Async snapshots describe execution steps; fleet totals also count workflow containers and plans. */
function snapshotWorkers(value: unknown): Worker[] | null {
  const snapshot = record(value)
  const omitted = record(snapshot?.omitted)
  if (
    snapshot?.version !== 1 ||
    snapshot.kind !== 'pi-subagents.async-status-snapshot' ||
    !Array.isArray(snapshot.runs) ||
    omitted?.runs !== 0 ||
    omitted.children !== 0 ||
    omitted.byteLimitExceeded !== false
  ) {
    return null
  }
  const workers: Worker[] = []
  const ids = new Set<string>()
  let nodes = 0
  const visit = (value: unknown, parents: string[], depth: number): boolean => {
    const node = record(value)
    const id = text(node?.id)
    if (
      !node ||
      !id ||
      depth > 8 ||
      ++nodes > 256 ||
      !['workflow', 'subagent', 'step', 'host-step'].includes(String(node.kind)) ||
      ![
        'queued',
        'running',
        'complete',
        'failed',
        'partial',
        'paused',
        'stopped',
        'rejected'
      ].includes(String(node.state))
    ) {
      return false
    }
    const path = [...parents, id]
    const key = JSON.stringify(path)
    if (ids.has(key)) {
      return false
    }
    ids.add(key)
    if (node.kind === 'step' && node.state === 'running') {
      const agent = text(node.agent)
      // Queued graph lanes and workflow roots are not confirmed child execution.
      if (!agent || !Number.isSafeInteger(node.startedAt) || Number(node.startedAt) < 0) {
        return false
      }
      if (agent !== 'workflow') {
        const label = text(node.label)
        workers.push({
          id: createHash('sha256').update(key).digest('hex'),
          name: agent,
          description: label ? `Pi background worker: ${label}` : 'Pi background worker'
        })
      }
    }
    if (workers.length > 64 || (node.children !== undefined && !Array.isArray(node.children))) {
      return false
    }
    return (
      !Array.isArray(node.children) || node.children.every((child) => visit(child, path, depth + 1))
    )
  }
  return snapshot.runs.every((run) => visit(run, [], 0)) ? workers : null
}

/** Read-only observations: no provider run IDs, stop targets, or execution authority. */
export class PiRpcNativeWorkers {
  private instance: string | null = null
  private sequence = 0
  private closed = false
  private active = false
  private pending: Worker[] | null = null
  private readonly live = new Map<string, AgentChildWorkLiveObservation>()
  private unavailable = true

  constructor(
    private readonly deliver: (evidence: AgentChildWorkEvidence[]) => void,
    private readonly diagnostic: (unavailable: boolean) => void
  ) {}

  activate(): void {
    if (this.closed) {
      return
    }
    this.active = true
    this.diagnostic(this.unavailable)
    if (this.pending) {
      this.replace(this.pending)
    }
    this.pending = null
  }

  receive(frame: JsonlRpcRecord): boolean {
    if (frame.method !== 'setStatus') {
      return false
    }
    if (this.closed) {
      return frame.statusKey === PI_NATIVE_WORKERS_STATUS_KEY
    }
    if (frame.statusKey === PI_BACKGROUND_WORK_STATUS_KEY) {
      const status = typeof frame.statusText === 'string' ? frame.statusText : ''
      if (status.startsWith('ready:') && status.split(':').length === 2 && status.length <= 256) {
        if (this.instance === status.slice(6)) {
          return false
        }
        this.replace([])
        this.setUnavailable(true)
        this.pending = null
        this.instance = status.slice(6)
        this.sequence = 0
      } else if (status === 'gone') {
        this.replace([])
        this.setUnavailable(true)
        this.pending = null
        this.instance = null
      }
      return false
    }
    if (frame.statusKey !== PI_NATIVE_WORKERS_STATUS_KEY) {
      return false
    }
    if (!this.instance) {
      return true
    }
    let packet: Record<string, unknown> | null = null
    try {
      if (
        typeof frame.statusText === 'string' &&
        Buffer.byteLength(frame.statusText) <= MAX_SNAPSHOT_BYTES
      ) {
        packet = record(JSON.parse(frame.statusText))
      }
    } catch {}
    if (packet && packet.instance !== this.instance) {
      return true
    }
    if (
      packet &&
      Number.isSafeInteger(packet.sequence) &&
      Number(packet.sequence) <= this.sequence
    ) {
      return true
    }
    if (packet && Number.isSafeInteger(packet.sequence)) {
      this.sequence = Number(packet.sequence)
    }
    const workers =
      packet?.version === 1 && Number.isSafeInteger(packet.sequence) && packet.state === 'known'
        ? snapshotWorkers(packet.asyncSnapshot)
        : null
    this.setUnavailable(workers === null)
    if (this.active) {
      this.replace(workers ?? [])
    } else {
      this.pending = workers
    }
    return true
  }

  end(): void {
    this.closed = true
    this.active = false
    this.instance = null
    this.pending = null
    this.replace([])
    this.setUnavailable(true)
  }

  private setUnavailable(unavailable: boolean): void {
    if (this.unavailable === unavailable) {
      return
    }
    this.unavailable = unavailable
    if (this.active) {
      this.diagnostic(unavailable)
    }
  }

  private replace(workers: Worker[]): void {
    const observedAt = Date.now()
    const evidence: AgentChildWorkEvidence[] = []
    const retained = new Set(workers.map((worker) => worker.id))
    for (const [id, child] of this.live) {
      if (!retained.has(id)) {
        evidence.push({ type: 'ended', handle: child.handle, outcome: 'unknown', observedAt })
        this.live.delete(id)
      }
    }
    for (const worker of workers) {
      const child: AgentChildWorkLiveObservation = {
        handle: {
          idKind: 'task_id',
          id: `pi-background:${worker.id}`,
          runId: `${this.instance}:${worker.id}`
        },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        name: worker.name,
        description: worker.description,
        agentType: worker.name,
        stoppable: false
      }
      evidence.push({
        type: 'live',
        observedAt,
        child,
        ...(!this.live.has(worker.id) ? { restart: true as const } : {})
      })
      this.live.set(worker.id, child)
    }
    if (evidence.length) {
      this.deliver(evidence)
    }
  }
}
