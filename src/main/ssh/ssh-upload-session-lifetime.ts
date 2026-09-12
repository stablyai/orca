import type { FileUploadSession } from '../providers/filesystem-provider-contract'
import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

export async function openTrackedSshUploadSession(
  ledger: SshConnectionWorkLedger,
  open: () => Promise<FileUploadSession>
): Promise<FileUploadSession> {
  const lifetime = ledger.beginSession()
  let session: FileUploadSession
  try {
    session = await lifetime.run(open)
  } catch (error) {
    lifetime.close(error)
    throw error
  }
  let closed = false
  return {
    uploadFile: (...args) => lifetime.run(() => session.uploadFile(...args)),
    close: () => {
      if (closed) {
        return
      }
      closed = true
      try {
        session.close()
      } catch (error) {
        lifetime.close(error)
        throw error
      }
      lifetime.close()
    }
  }
}
