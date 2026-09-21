import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  capturePathExistence,
  requirePathExistenceResults,
  validatePathExistenceBatch,
  type PathExistenceResult
} from '../../shared/path-existence-batch'
import { probeSshPathExistenceBatchCapability } from './ssh-filesystem-provider-capabilities'

export async function readSshPathExistenceBatch(
  mux: SshChannelMultiplexer,
  paths: string[],
  stat: (path: string) => Promise<unknown>
): Promise<PathExistenceResult[]> {
  validatePathExistenceBatch(paths)
  if (await probeSshPathExistenceBatchCapability(mux)) {
    try {
      return requirePathExistenceResults(
        await mux.request('fs.pathsExist', { filePaths: paths }),
        paths.length
      )
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error
      }
    }
  }
  return Promise.all(
    paths.map((path) =>
      capturePathExistence(async () => {
        try {
          await stat(path)
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
