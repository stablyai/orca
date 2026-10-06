import type { SFTPWrapper } from 'ssh2'
import type { SftpFactory } from './ssh-filesystem-download'
import { isSftpDirectoryChannelRetired } from './ssh-sftp-directory-close'

export class SftpFilesystemChannel {
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private disposed = false

  constructor(private readonly createSftp: SftpFactory) {}

  dispose(): void {
    this.disposed = true
    const pending = this.sftpPromise
    this.sftpPromise = null
    void pending?.then(
      (sftp) => sftp.end(),
      () => {}
    )
  }

  async get(): Promise<SFTPWrapper> {
    if (this.disposed) {
      throw new Error('SSH connection is not active')
    }
    if (!this.sftpPromise) {
      const opening = this.createSftp().then((sftp) => {
        if (isSftpDirectoryChannelRetired(sftp)) {
          throw new Error('SFTP factory returned a retired directory channel')
        }
        // Why: a closed channel must not be reused; the next call reopens one.
        sftp.once('close', () => {
          if (this.sftpPromise === opening) {
            this.sftpPromise = null
          }
        })
        return sftp
      })
      opening.catch(() => {
        if (this.sftpPromise === opening) {
          this.sftpPromise = null
        }
      })
      this.sftpPromise = opening
    }
    const opening = this.sftpPromise
    const sftp = await opening
    if (isSftpDirectoryChannelRetired(sftp)) {
      if (this.sftpPromise === opening) {
        this.sftpPromise = null
      }
      return this.get()
    }
    return sftp
  }
}
