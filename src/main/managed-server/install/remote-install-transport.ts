import type { Duplex, Readable, Writable } from 'node:stream'
import type { SshRemoteFileOptions } from '../../ssh/ssh-connection-file-transfers'
import type { SshExecOptions } from '../../ssh/ssh-connection-utils'

type RemoteFileWriteOptions = SshRemoteFileOptions & { signal?: AbortSignal }

/**
 * A command running on the host: reads are its stdout, writes its stdin. Emits `exit` with the
 * exit code when the host reports one, then `close` (with that code) once the channel is gone.
 */
export type RemoteCommandChannel = Duplex & {
  readonly stdin: Writable
  readonly stderr: Readable
  close(): void
}

/** What remote install, lock, GC and host-probe code uses from a host connection. */
export type RemoteInstallTransport = {
  exec(command: string, options?: SshExecOptions): Promise<RemoteCommandChannel>
  /**
   * Optional: `exec` for a command whose stdin the caller never writes, which may run with stdin
   * at EOF. Lets a transport whose every exec is a process start reuse one (WSL); SSH has none.
   */
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
