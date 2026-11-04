import { restartCanonicalPtyRun } from './canonical-pty-restart'
import type { Store } from '../../persistence/loading-store/store'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../providers/pty-provider-contract'
import { SessionNotFoundError } from '../../daemon/daemon-errors'
import { mintPtySessionId } from '../../daemon/pty-session-id'
import {
  runLeafOf,
  type SurfaceRunTarget
} from '../../../shared/workspace-surfaces/surface-allocation'

/** A captured pane owns each outliving create, including a reply lost before publication. */
export class CanonicalPtyRun {
  private enrolled: SurfaceRunTarget | undefined

  constructor(
    private readonly store: Store,
    private target: SurfaceRunTarget | null
  ) {}

  get bindingTarget(): SurfaceRunTarget | undefined {
    return this.enrolled
  }

  /** Retire the captured run durably before the ordinary replacement stops its process. */
  async replace(resourceId: string): Promise<void> {
    if (!this.target) {
      throw new Error('terminal_pane_owner_changed')
    }
    const target = this.target
    const result = await this.store.readWorkspaceSurface({
      type: 'run',
      hostId: target.hostId,
      target
    })
    if (result.type !== 'run') {
      throw new Error('Unexpected surface read')
    }
    const surface = result.surface
    const leaf = runLeafOf(surface, target)
    if (
      !leaf ||
      surface?.content?.kind !== 'terminal' ||
      (leaf.facts.ptyId && leaf.facts.ptyId !== resourceId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    // An earlier restart already owns the unbound run; keep that exact admission.
    if (!leaf.facts.ptyId) {
      return
    }
    this.target = await restartCanonicalPtyRun(this.store, target)
  }

  async spawn(
    provider: Pick<IPtyProvider, 'spawn' | 'surfaceExecution'>,
    options: PtySpawnOptions,
    beforeDispatch: () => void
  ): Promise<PtySpawnResult> {
    if (!this.target) {
      throw new Error('terminal_pane_owner_changed')
    }
    const target = this.target
    const current = await this.store.readWorkspaceSurface({
      type: 'run',
      hostId: target.hostId,
      target
    })
    if (current.type !== 'run') {
      throw new Error('Unexpected surface read')
    }
    const surface = current.surface
    const leaf = runLeafOf(surface, target)
    if (!leaf || surface?.content?.kind !== 'terminal') {
      throw new Error('terminal_pane_owner_changed')
    }
    if (leaf.facts.ptyId && !this.enrolled) {
      try {
        beforeDispatch()
        const attached = await provider.spawn({
          ...options,
          sessionId: leaf.facts.ptyId,
          attachOnly: true,
          ...(leaf.facts.incarnationId ? { expectedIncarnationId: leaf.facts.incarnationId } : {})
        })
        if (
          attached.id !== leaf.facts.ptyId ||
          (leaf.facts.incarnationId && attached.incarnationId !== leaf.facts.incarnationId)
        ) {
          throw new Error('terminal_pane_owner_changed')
        }
        return attached
      } catch (error) {
        if (!(error instanceof SessionNotFoundError) || options.attachOnly) {
          throw error
        }
      }
      this.target = await restartCanonicalPtyRun(this.store, target)
      options.sessionId = mintPtySessionId(options.worktreeId)
      options.isNewSession = true
    }
    if (options.attachOnly) {
      throw new SessionNotFoundError(options.sessionId ?? '')
    }
    const scope = this.store.captureSurfaceExecutionScope()
    if (!scope) {
      throw new Error('Terminal execution requires its admitted profile owner')
    }
    let resourceId = options.sessionId ?? mintPtySessionId(options.worktreeId)
    let candidate = {
      scope,
      hostId: this.target.hostId,
      allocationId: this.target.runId,
      resourceId
    }
    let executor = await provider.surfaceExecution?.identify(candidate)
    const prior = current.allocation?.allocationId === this.target.runId ? current.allocation : null
    if (
      (!prior && !leaf.facts.ptyId) ||
      (prior?.resourceId &&
        (prior.decision === 'aborting' ||
          (executor && prior.executorId && prior.executorId !== executor.executorId)))
    ) {
      this.target = await restartCanonicalPtyRun(this.store, this.target)
      this.enrolled = undefined
      resourceId = mintPtySessionId(options.worktreeId)
      options.sessionId = resourceId
      options.isNewSession = true
      candidate = { ...candidate, allocationId: this.target.runId, resourceId }
      executor = await provider.surfaceExecution?.identify(candidate)
    }
    const enrolled = await this.store.executeWorkspaceSurfaceCommand({
      type: 'begin-run',
      hostId: this.target.hostId,
      target: this.target,
      resourceId,
      ...(executor ? executor : {})
    })
    const decision = enrolled.outcome
    if (
      !decision ||
      typeof decision !== 'object' ||
      !('status' in decision) ||
      decision.status !== 'accepted' ||
      !('allocation' in decision) ||
      decision.allocation.decision !== 'pending' ||
      !decision.allocation.resourceId
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    this.enrolled = decision.allocation.target
    options.sessionId = decision.allocation.resourceId
    if (decision.allocation.executorId) {
      options.surfaceExecution = {
        scope,
        hostId: this.enrolled.hostId,
        allocationId: this.enrolled.runId,
        resourceId: decision.allocation.resourceId,
        executorId: decision.allocation.executorId,
        provenance: decision.allocation.provenance ?? null
      }
    }
    beforeDispatch()
    return provider.spawn(options)
  }

  /** A transport error cannot prove whether the executor has created or stopped the process. */
  async abort(): Promise<void> {
    if (!this.enrolled) {
      return
    }
    await this.store.executeWorkspaceSurfaceCommand({
      type: 'abort-run',
      hostId: this.enrolled.hostId,
      allocationId: this.enrolled.runId
    })
  }
}
