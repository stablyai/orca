import { parentPort, workerData } from 'node:worker_threads'
import { writeProfileStateBackup } from './profile-state-backup-job'
import { isRecord } from './profile-state-document-validation'

if (!parentPort) {
  throw new Error('Profile state backup must run on a worker thread')
}
const port = parentPort
const request: unknown = workerData
if (
  !isRecord(request) ||
  typeof request.databasePath !== 'string' ||
  typeof request.profileId !== 'string' ||
  typeof request.targetPath !== 'string'
) {
  throw new Error('Invalid profile state backup request')
}

void writeProfileStateBackup({
  databasePath: request.databasePath,
  profileId: request.profileId,
  targetPath: request.targetPath
})
  .then(
    () => port.postMessage({ ok: true }),
    (error: unknown) => port.postMessage({ ok: false, error: String(error) })
  )
  .finally(() => port.close())
