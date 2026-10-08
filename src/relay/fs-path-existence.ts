import { statRelayPath } from './fs-path-metadata-requests'
import { capturePathExistence, validatePathExistenceBatch } from '../shared/path-existence-batch'

export async function pathsExistOnRelay(params: Record<string, unknown>) {
  const paths = params.filePaths
  validatePathExistenceBatch(paths)
  return Promise.all(
    paths.map((filePath) =>
      capturePathExistence(async () => {
        try {
          await statRelayPath({ filePath })
          return true
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return false
          }
          throw error
        }
      })
    )
  )
}
