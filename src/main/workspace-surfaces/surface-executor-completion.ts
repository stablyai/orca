import type { SurfaceResource } from '../../shared/workspace-surfaces/surface-allocation'
import type { PtyCreationDisposition } from '../../shared/pty-creation-disposition'

export async function completedSurfaceCreation(
  disposition: PtyCreationDisposition | undefined
): Promise<boolean> {
  if (!disposition) {
    return false
  }
  if (disposition.kind === 'no-fork') {
    return true
  }
  if (disposition.kind === 'unknown') {
    await disposition.recover?.()
    return false
  }
  await disposition.recover?.()
  await disposition.completion
  return disposition.kind === 'physical' && disposition.exitCode() !== null
}

export async function cancelSurfaceExecution(
  current: {
    completion: Promise<void>
    resource?: SurfaceResource
    disposition?: PtyCreationDisposition
    canceled: boolean
  },
  known: SurfaceResource | null,
  owner: {
    owns(resource: SurfaceResource): boolean
    stop(resource: SurfaceResource): Promise<boolean>
  }
): Promise<boolean> {
  await current.completion
  const resource = current.resource ?? known
  if (resource) {
    if (!owner.owns(resource) || !(await owner.stop(resource))) {
      // A retained exact physical completion can prove an exit after the host removed its live index.
      if (!(await completedSurfaceCreation(current.disposition))) {
        return false
      }
    }
  } else if (!(await completedSurfaceCreation(current.disposition))) {
    return false
  }
  current.canceled = true
  return true
}
