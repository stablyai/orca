/**
 * Upload by streaming bytes into a POSIX exec channel's stdin (design D5 transfer fallback), for
 * hosts whose SFTP subsystem is disabled or chrooted (#12868, #15479). Works on either transport
 * because it only needs `conn.exec`; the system-SSH transport already writes this way.
 *
 * Each file lands under a unique partial name and is renamed only after the host counts exactly
 * the bytes that were sent, so a transfer cut short never leaves a plausible-looking file behind.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-exec-command'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { makePosixWriteFileCommand } from './system-ssh-file-binary-transfer'
import { collectLocalUploadPlan } from './system-ssh-file-transfer'

export const EXEC_STDIN_WRITE_DONE = 'ORCA_EXEC_STDIN_WRITE_DONE'

type ExecStdinOptions = { signal?: AbortSignal }

/** `cat` into a partial file, check its size, then rename it into place. */
export function makeExecStdinWriteFileCommand(
  remotePath: string,
  byteLength: number,
  options: { token: string; executable?: boolean }
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`Invalid upload size: ${byteLength}`)
  }
  const part = `${remotePath}.orca-part-${options.token}`
  const escapedPart = shellEscape(part)
  const steps = [
    `mkdir -p ${shellEscape(posix.dirname(remotePath))}`,
    makePosixWriteFileCommand(part),
    // Why tr: BSD `wc -c` pads its count with spaces.
    `[ "$(wc -c < ${escapedPart} | tr -d ' ')" = ${byteLength} ]`,
    ...(options.executable ? [`chmod 755 ${escapedPart}`] : []),
    `mv -f ${escapedPart} ${shellEscape(remotePath)}`,
    `echo ${EXEC_STDIN_WRITE_DONE}`
  ]
  return `{ ${steps.join(' && ')}; } || { rm -f ${escapedPart}; exit 1; }`
}

async function writeViaExecStdin(
  conn: SshConnection,
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
    // Why the deploy bound: a runtime archive over a slow link outlasts the 30 s probe default.
    { signal: options?.signal, stdin, timeoutMs: RELAY_DEPLOY_TIMEOUT_MS }
  )
  if (output.trim().split('\n').at(-1) !== EXEC_STDIN_WRITE_DONE) {
    throw new Error(`The host did not confirm the upload of ${remotePath}`)
  }
}

export async function uploadFileViaExecStdin(
  conn: SshConnection,
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
  conn: SshConnection,
  remotePath: string,
  contents: string,
  options?: ExecStdinOptions
): Promise<void> {
  const bytes = Buffer.from(contents, 'utf-8')
  await writeViaExecStdin(conn, remotePath, bytes.length, Readable.from([bytes]), false, options)
}

/** One exec creates the tree (empty directories included), then one exec per file. */
export async function uploadDirectoryViaExecStdin(
  conn: SshConnection,
  localDir: string,
  remoteDir: string,
  host: RemoteHostPlatform,
  options?: ExecStdinOptions
): Promise<void> {
  const plan = await collectLocalUploadPlan(localDir, remoteDir, host, options?.signal)
  await execCommand(conn, `mkdir -p ${plan.directories.map(shellEscape).join(' ')}`, {
    signal: options?.signal
  })
  for (const file of plan.files) {
    options?.signal?.throwIfAborted()
    await uploadFileViaExecStdin(conn, file.localPath, file.remotePath, options)
  }
}
