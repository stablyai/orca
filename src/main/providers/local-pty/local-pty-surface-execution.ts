import { SurfaceRunExecutor } from '../../workspace-surfaces/surface-run-executor'
import { SurfaceExecutorReader } from '../../workspace-surfaces/surface-executor-reader'
import { TerminalCreationWork } from '../../daemon/terminal-host/terminal-creation-work'
import { ptyIncarnations, ptyProcesses } from './local-pty-provider-state'
import { shutdownLocalPty } from './local-pty-termination'
import { spawnLocalPty } from './local-pty-spawn'
import type { PtySpawnOptions } from '../pty-provider-contract'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { SurfaceResource } from '../../../shared/workspace-surfaces/surface-allocation'

const reader = new SurfaceExecutorReader()
const owns = (resource: SurfaceResource): boolean =>
  ptyProcesses.has(resource.ptyId) &&
  resource.incarnationId !== undefined &&
  ptyIncarnations.get(resource.ptyId) === resource.incarnationId

// Local provider instances share the same physical owner maps, including after window replacement.
export const localSurfaceExecutor = new SurfaceRunExecutor({
  read: (admission) => reader.read(admission),
  owns,
  stop: async (resource) => {
    if (!owns(resource)) {
      return false
    }
    await shutdownLocalPty(resource.ptyId, { immediate: true })
    return !owns(resource)
  }
})

export function spawnSurfaceLocalPty(
  args: PtySpawnOptions,
  getOptions: () => LocalPtyProviderOptions
) {
  const admission = args.surfaceExecution
  if (!admission || args.attachOnly) {
    return spawnLocalPty(args, getOptions)
  }
  if (args.sessionId !== admission.resourceId) {
    return Promise.reject(new Error('terminal_allocation_changed'))
  }
  return localSurfaceExecutor.run(
    admission,
    async (control) => {
      const work = new TerminalCreationWork()
      try {
        const value = await spawnLocalPty(
          {
            ...args,
            signal: args.signal ? AbortSignal.any([args.signal, control.signal]) : control.signal
          },
          getOptions,
          { control, work }
        )
        return {
          value,
          resource: {
            ptyId: value.id,
            ...(value.incarnationId ? { incarnationId: value.incarnationId } : {})
          }
        }
      } finally {
        await work.finish()
        control.disposition(await work.completion)
      }
    },
    (resource) =>
      spawnLocalPty(
        {
          ...args,
          sessionId: resource.ptyId,
          attachOnly: true,
          expectedIncarnationId: resource.incarnationId
        },
        getOptions
      )
  )
}
