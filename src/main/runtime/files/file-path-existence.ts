import {
  capturePathExistence,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import { isPathAbsentError } from '../../ipc/filesystem-path-containment'
import {
  requireRuntimeFileProvider,
  type RuntimeFileExplorerPath,
  type RuntimeLocalFileHost
} from './file-target'

export async function readRuntimeFilePathExistence(
  targets: readonly RuntimeFileExplorerPath[],
  host: RuntimeLocalFileHost
): Promise<PathExistenceResult[]> {
  if (targets.length === 0) {
    return []
  }
  const provider = requireRuntimeFileProvider(targets[0], host)
  if (provider.pathsExist) {
    return provider.pathsExist(targets.map((target) => target.path))
  }
  return Promise.all(
    targets.map((target) =>
      capturePathExistence(async () => {
        try {
          await provider.stat(target.path)
          return true
        } catch (error) {
          if (isPathAbsentError(error)) {
            return false
          }
          throw error
        }
      })
    )
  )
}
