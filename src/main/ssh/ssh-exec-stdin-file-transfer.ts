/** Stream into POSIX exec stdin when SFTP is disabled/chrooted (#12868, #15479). Rename unique partial files only after exact host byte-count verification so truncated transfers cannot look complete. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { execCommand } from './remote-exec/remote-exec-command'
import { REMOTE_INSTALL_TIMEOUT_MS } from '../managed-server/install/remote-deploy-timing'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { makePosixWriteFileCommand } from './system-transport/system-ssh-file-binary-transfer'
import { collectLocalUploadPlan } from './system-transport/system-ssh-file-transfer'

export const EXEC_STDIN_WRITE_DONE = 'ORCA_EXEC_STDIN_WRITE_DONE'

type ExecStdinOptions = { signal?: AbortSignal }

export function makeExecStdinWriteFileCommand(
  remotePath: string,
  byteLength: number,
  options: { token: string; executable?: boolean }
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`Invalid upload size: ${byteLength}`)
  }
  const part = `${remotePath}.orca-part-${options.token}`
  const escapedPart = quotePosixShell(part)
  const steps = [
    `mkdir -p ${quotePosixShell(posix.dirname(remotePath))}`,
    makePosixWriteFileCommand(part),
    // Why tr: BSD `wc -c` pads its count with spaces.
    `[ "$(wc -c < ${escapedPart} | tr -d ' ')" = ${byteLength} ]`,
    ...(options.executable ? [`chmod 755 ${escapedPart}`] : []),
    `mv -f ${escapedPart} ${quotePosixShell(remotePath)}`,
    `echo ${EXEC_STDIN_WRITE_DONE}`
  ]
  return `{ ${steps.join(' && ')}; } || { rm -f ${escapedPart}; exit 1; }`
}

async function writeViaExecStdin(
  conn: RemoteInstallTransport,
  remotePath: string,
  byteLength: number,
  stdin: Readable,
  executable: boolean,
  options?: ExecStdinOptions
): Promise<void> {
  const token = randomBytes(8).toString('hex')
  const output = await execCommand(
    conn,
    makeExecStdinWriteFileCommand(remotePath, byteLength, { token, executable }),
    // Runtime archives on slow links need the deploy deadline, not the 30s probe timeout.
    { signal: options?.signal, stdin, timeoutMs: REMOTE_INSTALL_TIMEOUT_MS }
  )
  if (output.trim().split('\n').at(-1) !== EXEC_STDIN_WRITE_DONE) {
    throw new Error(`The host did not confirm the upload of ${remotePath}`)
  }
}

export async function uploadFileViaExecStdin(
  conn: RemoteInstallTransport,
  localPath: string,
  remotePath: string,
  options?: ExecStdinOptions
): Promise<void> {
  options?.signal?.throwIfAborted()
  const sourceStat = await lstat(localPath)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Unsupported upload source: ${localPath}`)
  }
  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    // Same identity check as the system-SSH writer; some Windows filesystems report inode 0.
    if (
      !opened.isFile() ||
      opened.size !== sourceStat.size ||
      (sourceStat.ino !== 0 && opened.ino !== 0 && opened.ino !== sourceStat.ino)
    ) {
      throw new Error(`File changed during upload: ${localPath}`)
    }
    const input = handle.createReadStream({ autoClose: false })
    await writeViaExecStdin(
      conn,
      remotePath,
      opened.size,
      input,
      (opened.mode & 0o111) !== 0,
      options
    )
  } finally {
    await handle.close()
  }
}

export async function writeStringViaExecStdin(
  conn: RemoteInstallTransport,
  remotePath: string,
  contents: string,
  options?: ExecStdinOptions
): Promise<void> {
  const bytes = Buffer.from(contents, 'utf-8')
  await writeViaExecStdin(conn, remotePath, bytes.length, Readable.from([bytes]), false, options)
}

export async function uploadDirectoryViaExecStdin(
  conn: RemoteInstallTransport,
  localDir: string,
  remoteDir: string,
  host: RemoteHostPlatform,
  options?: ExecStdinOptions
): Promise<void> {
  const plan = await collectLocalUploadPlan(localDir, remoteDir, host, options?.signal)
  await execCommand(conn, `mkdir -p ${plan.directories.map(quotePosixShell).join(' ')}`, {
    signal: options?.signal
  })
  for (const file of plan.files) {
    options?.signal?.throwIfAborted()
    await uploadFileViaExecStdin(conn, file.localPath, file.remotePath, options)
  }
}
