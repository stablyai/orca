import { surfaceExecutionKernelChanged } from '../../shared/workspace-surfaces/surface-execution-provenance'
import { isDeepStrictEqual } from 'node:util'
import type { SurfaceAllocation } from '../../shared/workspace-surfaces/surface-allocation'
import type {
  SurfaceExecutionScope,
  SurfaceExecutorAdmission,
  SurfaceExecutorResult
} from '../../shared/workspace-surfaces/surface-executor-contract'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import type { IPtyProvider } from '../providers/pty-provider-contract'

type PendingDecision = { hostId: string; allocation: SurfaceAllocation }

/** Committed decisions wake work; unchanged unknown outcomes park until a provider/storage wake. */
export class SurfaceAllocationRecovery {
  private readonly latest = new Map<string, PendingDecision>()
  private readonly dirty = new Set<string>()
  private readonly active = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly deps: {
      pending?(hostId: string, pending: boolean): void
      scope(): SurfaceExecutionScope | undefined
      provider(hostId: string): Pick<IPtyProvider, 'surfaceExecution'> | undefined
      execute(command: SurfaceStorageCommand): Promise<SurfaceStorageResult>
    }
  ) {}

  observe(
    result: Pick<SurfaceStorageResult, 'hostId' | 'allocations'> &
      Partial<Pick<SurfaceStorageResult, 'host'>>,
    wake = false
  ): void {
    if (this.disposed) {
      return
    }
    // Same-boot unknown work keeps interest until an owner/domain wake, never a launch gate.
    this.deps.pending?.(
      result.hostId,
      result.allocations.some((allocation) =>
        Boolean(allocation.resourceId && allocation.executorId)
      )
    )
    const present = new Set<string>()
    for (const allocation of result.allocations) {
      const key = JSON.stringify([result.hostId, allocation.allocationId])
      present.add(key)
      const before = this.latest.get(key)
      this.latest.set(key, { hostId: result.hostId, allocation: structuredClone(allocation) })
      if (wake || !isDeepStrictEqual(before?.allocation, allocation)) {
        this.enqueue(key)
      }
    }
    for (const [key, decision] of this.latest) {
      if (decision.hostId === result.hostId && !present.has(key)) {
        this.latest.delete(key)
      }
    }
  }

  async wake(hostId: string): Promise<void> {
    if (this.disposed) {
      return
    }
    try {
      this.observe(await this.deps.execute({ type: 'query', hostId }), true)
    } catch {}
  }

  async drain(): Promise<void> {
    while (this.active.size) {
      await Promise.all(this.active.values())
    }
  }

  wakeAllocation(admission: SurfaceExecutorAdmission): void {
    const key = JSON.stringify([admission.hostId, admission.allocationId])
    const allocation = this.latest.get(key)?.allocation
    if (
      allocation?.resourceId === admission.resourceId &&
      allocation.executorId === admission.executorId &&
      isDeepStrictEqual(allocation.provenance ?? null, admission.provenance ?? null)
    ) {
      this.enqueue(key)
    }
  }

  dispose(): void {
    this.disposed = true
    this.dirty.clear()
    this.latest.clear()
  }

  private enqueue(key: string): void {
    this.dirty.add(key)
    if (this.active.has(key)) {
      return
    }
    // Delivery never holds the profile queue or a native prepared-record admission.
    const work = Promise.resolve()
      .then(async () => {
        while (!this.disposed && this.dirty.delete(key)) {
          const decision = this.latest.get(key)
          if (!decision) {
            continue
          }
          try {
            await this.recover(decision)
          } catch {}
        }
      })
      .finally(() => {
        this.active.delete(key)
        if (!this.disposed && this.dirty.has(key)) {
          this.enqueue(key)
        }
      })
    this.active.set(key, work)
  }

  private async recover({ hostId, allocation }: PendingDecision): Promise<void> {
    if (this.disposed) {
      return
    }
    const execute = (command: SurfaceStorageCommand) => {
      if (this.disposed) {
        throw new Error('Surface recovery is finalized')
      }
      return this.deps.execute(command)
    }
    if (!allocation.resourceId) {
      // Dispatch requires a fixed resource and elected owner in a preceding committed command.
      if (allocation.decision === 'aborting') {
        await execute({
          type: 'acknowledge-run',
          hostId,
          acknowledgment: {
            hostId,
            allocationId: allocation.allocationId,
            decision: 'aborting',
            proof: 'stopped_and_fenced'
          }
        })
      }
      return
    }
    const scope = this.deps.scope()
    const provider = this.deps.provider(hostId)
    if (!scope || !provider || !allocation.executorId) {
      return
    }
    const admission: SurfaceExecutorAdmission = {
      scope,
      hostId,
      allocationId: allocation.allocationId,
      resourceId: allocation.resourceId,
      executorId: allocation.executorId,
      provenance: allocation.provenance ?? null
    }
    const executor = provider.surfaceExecution
    if (!executor) {
      return
    }
    if (allocation.decision === 'pending') {
      const result = await executor.query(admission)
      if (!this.exact(result, admission) || result.state.kind === 'unverifiable') {
        await this.recoverKernelChange(hostId, allocation, admission, executor)
        return
      }
      if (result.state.kind === 'prepared' || result.state.kind === 'adopted') {
        await execute({
          type: 'bind-run',
          hostId,
          allocationId: allocation.allocationId,
          resource: result.state.resource
        })
      } else if (result.state.kind === 'canceled') {
        await execute({ type: 'abort-run', hostId, allocationId: allocation.allocationId })
      }
      return
    }
    const resource = allocation.resource
    if (allocation.decision === 'committed' && !resource) {
      return
    }
    const result = await executor.settle(
      allocation.decision === 'aborting'
        ? { admission, decision: 'aborting', resource }
        : { admission, decision: 'committed', resource: resource! }
    )
    if (!this.exact(result, admission) || result.state.kind === 'unverifiable') {
      await this.recoverKernelChange(hostId, allocation, admission, executor)
      return
    }
    const acknowledgment =
      allocation.decision === 'aborting'
        ? result.state.kind === 'canceled'
          ? {
              hostId,
              allocationId: allocation.allocationId,
              executorId: allocation.executorId,
              decision: 'aborting' as const,
              proof: 'stopped_and_fenced' as const
            }
          : null
        : result.state.kind === 'adopted' && isDeepStrictEqual(result.state.resource, resource)
          ? {
              hostId,
              allocationId: allocation.allocationId,
              executorId: allocation.executorId,
              decision: 'committed' as const,
              resource: resource!
            }
          : null
    if (!acknowledgment) {
      return
    }
    const acknowledged = await execute({ type: 'acknowledge-run', hostId, acknowledgment })
    if (acknowledged.outcome === true) {
      await executor.release(admission)
    }
  }

  private async recoverKernelChange(
    hostId: string,
    subject: SurfaceAllocation,
    admission: SurfaceExecutorAdmission,
    executor: NonNullable<IPtyProvider['surfaceExecution']>
  ): Promise<void> {
    const observer = await executor.identify(admission)
    if (
      this.disposed ||
      !observer ||
      !surfaceExecutionKernelChanged(subject.provenance, observer.provenance)
    ) {
      return
    }
    await this.deps.execute({ type: 'retire-kernel-run', hostId, subject, observer })
  }

  private exact(result: SurfaceExecutorResult, admission: SurfaceExecutorAdmission): boolean {
    return (
      result.executorId === admission.executorId && isDeepStrictEqual(result.admission, admission)
    )
  }
}
