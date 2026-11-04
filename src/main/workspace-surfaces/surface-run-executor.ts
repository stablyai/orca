import { completedSurfaceCreation } from './surface-executor-completion'
import { isDeepStrictEqual } from 'node:util'
import { readSurfaceExecutionProvenance } from './surface-execution-provenance'
import type {
  SurfaceExecutorIdentity,
  SurfaceExecutionProvenance
} from '../../shared/workspace-surfaces/surface-execution-provenance'
import { randomUUID } from 'node:crypto'
import type { PtyCreationDisposition } from '../../shared/pty-creation-disposition'
import type { SurfaceResource } from '../../shared/workspace-surfaces/surface-allocation'
import {
  surfaceExecutorKey,
  type SurfaceExecutorAdmission,
  type SurfaceExecutorDecision,
  type SurfaceExecutorIntent,
  type SurfaceExecutorResult
} from '../../shared/workspace-surfaces/surface-executor-contract'

export type SurfaceExecutionControl = {
  signal: AbortSignal
  assertAllowed(): void
  disposition(value: PtyCreationDisposition): void
}
type Execution = {
  admission: SurfaceExecutorAdmission
  cancellation: AbortController
  completion: Promise<void>
  finished: boolean
  registered: boolean
  resource?: SurfaceResource
  disposition?: PtyCreationDisposition
  cancelIntent?: Promise<boolean>
  adopted: boolean
  canceled: boolean
}

/** The carrier fences future creates; this executor owns every admitted physical attempt until proof. */
export class SurfaceRunExecutor {
  readonly executorId = randomUUID()
  private readonly wakeListeners = new Set<(admission: SurfaceExecutorAdmission) => void>()
  private readonly executions = new Map<string, Execution>()

  constructor(
    private readonly deps: {
      provenance?(): Promise<SurfaceExecutionProvenance>
      read(admission: SurfaceExecutorAdmission): Promise<SurfaceExecutorIntent>
      owns(resource: SurfaceResource): boolean
      stop(resource: SurfaceResource): Promise<boolean>
    }
  ) {}

  async identify(): Promise<SurfaceExecutorIdentity> {
    return {
      executorId: this.executorId,
      provenance: await (this.deps.provenance?.() ?? readSurfaceExecutionProvenance())
    }
  }

  onWake(listener: (admission: SurfaceExecutorAdmission) => void): () => void {
    this.wakeListeners.add(listener)
    return () => {
      this.wakeListeners.delete(listener)
    }
  }

  private wake(admission: SurfaceExecutorAdmission): void {
    for (const listener of this.wakeListeners) {
      try {
        listener(admission)
      } catch {}
    }
  }

  async run<T>(
    admission: SurfaceExecutorAdmission,
    create: (control: SurfaceExecutionControl) => Promise<{ value: T; resource: SurfaceResource }>,
    attach: (resource: SurfaceResource) => Promise<T>
  ): Promise<T> {
    admission = structuredClone(admission)
    if (admission.executorId !== this.executorId) {
      throw new Error('terminal_executor_changed')
    }
    const key = surfaceExecutorKey(admission)
    const previous = this.executions.get(key)
    if (previous) {
      this.sameResource(previous, admission)
      await previous.cancelIntent
      await previous.completion
      if (
        !previous.resource &&
        previous.disposition?.kind === 'no-fork' &&
        !previous.cancellation.signal.aborted &&
        previous.registered
      ) {
        if (this.executions.get(key) === previous) {
          this.executions.delete(key)
        }
        return this.run(admission, create, attach)
      }
      if (previous.cancellation.signal.aborted || previous.canceled || !previous.resource) {
        throw new Error('terminal_pane_owner_changed')
      }
      return attach(previous.resource)
    }
    const finished = Promise.withResolvers<void>()
    const execution: Execution = {
      admission,
      cancellation: new AbortController(),
      completion: finished.promise,
      adopted: false,
      canceled: false,
      finished: false,
      registered: true,
      disposition: { kind: 'no-fork' }
    }
    // Registration precedes the read, cwd validation and every other await that can outlive a close.
    this.executions.set(key, execution)
    const assertAllowed = () => {
      if (execution.cancellation.signal.aborted || execution.canceled) {
        throw new Error('terminal_pane_owner_changed')
      }
    }
    try {
      if (
        admission.provenance &&
        !isDeepStrictEqual(admission.provenance, (await this.identify()).provenance)
      ) {
        throw new Error('terminal_executor_domain_changed')
      }
      const intent = await this.deps.read(admission)
      await execution.cancelIntent
      assertAllowed()
      const bound =
        intent.kind === 'bound'
          ? intent.resource
          : intent.kind === 'allocation' && intent.allocation.decision === 'committed'
            ? intent.allocation.resource
            : null
      if (bound) {
        execution.resource = bound
        execution.adopted = true
        return await attach(bound)
      }
      if (intent.kind !== 'allocation' || intent.allocation.decision !== 'pending') {
        throw new Error('terminal_pane_owner_changed')
      }
      execution.disposition = undefined
      const result = await create({
        signal: execution.cancellation.signal,
        assertAllowed,
        disposition: (value) => {
          execution.disposition = value
        }
      })
      if (result.resource.ptyId !== admission.resourceId) {
        throw new Error('terminal_pane_owner_changed')
      }
      execution.resource = structuredClone(result.resource)
      await execution.cancelIntent
      assertAllowed()
      return result.value
    } finally {
      execution.finished = true
      finished.resolve()
      this.wake(admission)
    }
  }

  query(admission: SurfaceExecutorAdmission): SurfaceExecutorResult {
    if (admission.executorId !== this.executorId) {
      return this.result(admission, { kind: 'unverifiable' })
    }
    const execution = this.executions.get(surfaceExecutorKey(admission))
    if (execution) {
      this.sameResource(execution, admission)
    }
    return this.result(
      admission,
      execution?.canceled
        ? { kind: 'canceled' }
        : execution?.resource
          ? { kind: execution.adopted ? 'adopted' : 'prepared', resource: execution.resource }
          : execution && !execution.finished
            ? { kind: 'pending' }
            : { kind: 'unverifiable' }
    )
  }

  async settle(decision: SurfaceExecutorDecision): Promise<SurfaceExecutorResult> {
    const admission = structuredClone(decision.admission)
    if (admission.executorId !== this.executorId) {
      return this.result(admission, { kind: 'unverifiable' })
    }
    const key = surfaceExecutorKey(admission)
    let execution = this.executions.get(key)
    if (execution) {
      this.sameResource(execution, admission)
    } else {
      execution = {
        admission,
        cancellation: new AbortController(),
        completion: Promise.resolve(),
        finished: true,
        registered: false,
        adopted: false,
        canceled: false
      }
      this.executions.set(key, execution)
    }
    const current = execution
    if (decision.decision === 'committed') {
      await current.cancelIntent
      const intent = await this.deps.read(admission)
      const resource =
        intent.kind === 'bound'
          ? intent.resource
          : intent.kind === 'allocation' && intent.allocation.decision === 'committed'
            ? intent.allocation.resource
            : null
      if (
        !resource ||
        !sameResource(resource, decision.resource) ||
        !this.deps.owns(resource) ||
        current.canceled ||
        current.cancellation.signal.aborted
      ) {
        return this.result(admission, { kind: 'unverifiable' })
      }
      current.resource = resource
      current.adopted = true
      return this.result(admission, { kind: 'adopted', resource })
    }
    if (current.canceled) {
      return this.result(admission, { kind: 'canceled' })
    }
    current.cancelIntent ??= this.deps
      .read(admission)
      .then((intent) => {
        const accepted =
          intent.kind === 'allocation' &&
          intent.allocation.decision === 'aborting' &&
          intent.allocation.executorId === this.executorId
        if (accepted && !current.registered) {
          current.disposition = { kind: 'no-fork' }
        }
        if (accepted) {
          current.cancellation.abort(new Error('terminal_run_canceled'))
        }
        return accepted
      })
      .catch(() => false)
    if (!(await current.cancelIntent)) {
      current.cancelIntent = undefined
      return this.result(admission, { kind: 'unverifiable' })
    }
    await current.completion
    const resource = current.resource ?? decision.resource
    if (resource) {
      if (!this.deps.owns(resource) || !(await this.deps.stop(resource))) {
        // A retained exact physical completion can prove an exit after the host removed its live index.
        if (!(await completedSurfaceCreation(current.disposition))) {
          return this.result(admission, { kind: 'unverifiable' })
        }
      }
    } else if (!(await completedSurfaceCreation(current.disposition))) {
      return this.result(admission, { kind: 'unverifiable' })
    }
    current.canceled = true
    this.wake(admission)
    return this.result(admission, { kind: 'canceled' })
  }

  /** The owner's acknowledged absence is safe to forget because no later create can pass admission. */
  async release(admission: SurfaceExecutorAdmission): Promise<void> {
    const key = surfaceExecutorKey(admission)
    const execution = this.executions.get(key)
    if (!execution?.canceled) {
      return
    }
    const intent = await this.deps.read(admission)
    if (intent.kind === 'absent' && this.executions.get(key) === execution) {
      this.executions.delete(key)
    }
  }

  private sameResource(execution: Execution, admission: SurfaceExecutorAdmission): void {
    if (
      execution.admission.resourceId !== admission.resourceId ||
      !isDeepStrictEqual(execution.admission.provenance ?? null, admission.provenance ?? null)
    ) {
      throw new Error('terminal_allocation_changed')
    }
  }

  private result(
    admission: SurfaceExecutorAdmission,
    state: SurfaceExecutorResult['state']
  ): SurfaceExecutorResult {
    return structuredClone({ executorId: this.executorId, admission, state })
  }
}

function sameResource(a: SurfaceResource, b: SurfaceResource): boolean {
  return a.ptyId === b.ptyId && a.incarnationId === b.incarnationId
}
