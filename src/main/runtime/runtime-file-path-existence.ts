import { stat } from 'node:fs/promises'
import { capturePathExistence, type PathExistenceResult } from '../../shared/path-existence-batch'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { RuntimeFileCommandHost } from './runtime-file-command-host'
import {
  requireRuntimeFileProvider,
  type RuntimeFileExplorerPath
} from './runtime-file-command-target'

export async function readRuntimeFilePathExistence(
  targets: readonly RuntimeFileExplorerPath[],
  requireStore: RuntimeFileCommandHost['requireStore']
): Promise<PathExistenceResult[]> {
  if (targets.length === 0) {
    return []
  }
  const provider = requireRuntimeFileProvider(targets[0])
  if (provider?.pathsExist) {
    return provider.pathsExist(targets.map((target) => target.path))
  }
  return Promise.all(
    targets.map((target) =>
      capturePathExistence(async () => {
        try {
          await (provider
            ? provider.stat(target.path)
            : stat(await resolveAuthorizedPath(target.path, requireStore())))
          return true
        } catch (error) {
          if (isENOENT(error)) {
            return false
          }
          throw error
        }
      })
    )
  )
}
