import { SurfaceRunExecutor } from '../workspace-surfaces/surface-run-executor'
import { SurfaceExecutorReader } from '../workspace-surfaces/surface-executor-reader'
import type { SurfaceResource } from '../../shared/workspace-surfaces/surface-allocation'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { Session } from './session'

export class TerminalHostSurfaceExecution {
  private readonly reader = new SurfaceExecutorReader()
  readonly executor: SurfaceRunExecutor

  constructor(sessions: ReadonlyMap<string, Session>, kill: (id: string) => Promise<void>) {
    const owns = (resource: SurfaceResource): boolean => {
      const session = sessions.get(resource.ptyId)
      return Boolean(
        session && resource.incarnationId && session.incarnationId === resource.incarnationId
      )
    }
    this.executor = new SurfaceRunExecutor({
      read: (admission) => this.reader.read(admission),
      owns,
      stop: async (resource) => {
        if (!owns(resource)) {
          return false
        }
        const session = sessions.get(resource.ptyId)!
        if (session.isAlive) {
          await kill(resource.ptyId)
        }
        await session.physicalCompletion
        return !session.isAlive
      }
    })
  }

  run(
    options: InternalCreateOrAttachOptions,
    create: (options: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>
  ) {
    const admission = options.surfaceExecution
    if (!admission || options.attachOnly) {
      return create(options)
    }
    if (admission.resourceId !== options.sessionId) {
      return Promise.reject(new Error('terminal_allocation_changed'))
    }
    return this.executor.run(
      admission,
      async (control) => {
        const value = await create({
          ...options,
          surfaceExecution: undefined,
          isCanceled: () => control.signal.aborted || options.isCanceled?.() === true,
          cancelSignal: options.cancelSignal
            ? AbortSignal.any([options.cancelSignal, control.signal])
            : control.signal,
          onCreationDisposition: (disposition) => {
            control.disposition(disposition)
            options.onCreationDisposition?.(disposition)
          }
        })
        return { value, resource: { ptyId: options.sessionId, incarnationId: value.incarnationId } }
      },
      (resource) =>
        create({
          ...options,
          surfaceExecution: undefined,
          sessionId: resource.ptyId,
          expectedIncarnationId: resource.incarnationId,
          attachOnly: true
        })
    )
  }

  disposeReader(): void {
    this.reader.dispose()
  }
}
