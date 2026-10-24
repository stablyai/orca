import type { Duplex, Readable, Writable } from 'node:stream'
import type { SshRemoteFileOptions } from '../../ssh/connection/ssh-connection-file-transfers'
import type { SshExecOptions } from '../../ssh/connection/ssh-exec-options'

type RemoteFileWriteOptions = SshRemoteFileOptions & { signal?: AbortSignal }

/** exit reports the host status; close follows when the channel is gone. */
export type RemoteCommandChannel = Duplex & {
  readonly stdin: Writable
  readonly stderr: Readable
  close(): void
}

export type RemoteInstallTransport = {
  exec(command: string, options?: SshExecOptions): Promise<RemoteCommandChannel>
  /** WSL can reuse a process for closed-stdin commands; SSH leaves this absent. */
  execWithClosedStdin?(command: string, options?: SshExecOptions): Promise<RemoteCommandChannel>
  usesSystemSshTransport(): boolean
  /** Changes whenever the underlying transport is replaced; scopes per-transport verdicts. */
  getConnectGeneration(): number
  writeFile(remotePath: string, contents: string, options?: RemoteFileWriteOptions): Promise<void>
  uploadDirectory(
    localDir: string,
    remoteDir: string,
    options?: RemoteFileWriteOptions
  ): Promise<void>
}
