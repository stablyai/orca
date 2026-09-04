import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape } from './ssh-connection-utils'
import {
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  awaitWithSystemSshAbort,
  throwIfAborted,
  waitForChannelClose
} from './system-ssh-operation-lifecycle'
import {
  writeWindowsRemoteFile,
  type WindowsWriteSource
} from './system-ssh-windows-write-strategy'

export {
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS
} from './system-ssh-windows-write-strategy'
export { WINDOWS_STAGED_WRITE_SUFFIX } from './system-ssh-windows-file-write'

type SystemSshOperationOptions = SystemSshBuildArgsOptions & {
  signal?: AbortSignal
  hostPlatform?: RemoteHostPlatform
}

type SystemSshWriteBufferOptions = SystemSshOperationOptions & {
  append?: boolean
  exclusive?: boolean
}

type SystemSshUploadFileOptions = SystemSshOperationOptions & {
  exclusive?: boolean
}

export async function downloadFileViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  localPath: string,
  options?: SystemSshOperationOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  const isWindows = options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)
  const command = isWindows
    ? makeWindowsReadFileCommand(remotePath)
    : `cat ${shellEscape(remotePath)}`
  const channel = spawnSystemSshCommand(target, command, {
    wrapCommand: !isWindows,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const output = createWriteStream(localPath, { flags: 'wx' })
  try {
    await awaitWithSystemSshAbort(
      options?.signal,
      () => {
        channel.close()
        output.destroy()
      },
      Promise.all([
        waitForChannelClose(channel, `download ${remotePath}`),
        pipeline(channel, output)
      ])
    )
  } catch (error) {
    channel.close()
    output.destroy()
    throw error
  }
}

export async function writeBufferViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  contents: Buffer,
  options?: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
    await writeWindowsRemoteFile(
      target,
      remotePath,
      {
        totalBytes: contents.length,
        readChunk: (offset, maxBytes) =>
          Promise.resolve(contents.subarray(offset, Math.min(offset + maxBytes, contents.length))),
        withLocalFile: (send) => withTemporaryLocalFile(contents, send)
      },
      options ?? {}
    )
    return
  }

  const channel = spawnSystemSshCommand(
    target,
    makePosixWriteFileCommand(remotePath, options),
    getSystemSshBuildArgsFromOperationOptions(options)
  )
  const closePromise = awaitWithSystemSshAbort(
    options?.signal,
    () => channel.close(),
    waitForChannelClose(channel, `write ${remotePath}`)
  )
  if (!options?.signal?.aborted) {
    channel.stdin.end(contents)
  }
  await closePromise
}

export async function uploadFileViaSystemSsh(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  options?: SystemSshUploadFileOptions
): Promise<void> {
  throwIfAborted(options?.signal)
  const sourceStat = await lstat(localPath)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Unsupported upload source: ${localPath}`)
  }

  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile() ||
      openedStat.size !== sourceStat.size ||
      (sourceStat.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== sourceStat.ino) ||
      (sourceStat.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== sourceStat.dev)
    ) {
      throw new Error(`File changed during upload: ${localPath}`)
    }
    throwIfAborted(options?.signal)

    if (options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)) {
      // This is the path that carries the large files, so it is the one the transport choice is
      // made for; see the #16432 note below.
      const source: WindowsWriteSource = {
        totalBytes: openedStat.size,
        readChunk: async (offset, maxBytes) => {
          const buffer = Buffer.allocUnsafe(Math.min(maxBytes, openedStat.size - offset))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          return buffer.subarray(0, bytesRead)
        },
        // The verified local file is already exactly the payload, so sftp sends it as is.
        withLocalFile: (send) => send(localPath)
      }
      await writeWindowsRemoteFile(target, remotePath, source, options ?? {})
      return
    }

    const channel = spawnSystemSshCommand(
      target,
      makePosixWriteFileCommand(remotePath, options),
      getSystemSshBuildArgsFromOperationOptions(options)
    )
    const input = handle.createReadStream({ autoClose: false })
    try {
      await awaitWithSystemSshAbort(
        options?.signal,
        () => {
          input.destroy()
          channel.close()
        },
        Promise.all([
          waitForChannelClose(channel, `upload ${remotePath}`),
          pipeline(input, channel.stdin as Writable)
        ])
      )
    } catch (error) {
      input.destroy()
      channel.close()
      throw error
    }
  } finally {
    await handle.close()
  }
}

/**
 * #16432, re-measured: the constraint is not a size limit, and it is not cmd.exe's.
 *
 * A read on Windows PowerShell 5.1's redirected-stdin handle over a non-pty ssh exec can die
 * permanently when it finds the stream momentarily empty: no further bytes arrive, and no EOF ever
 * does. It is probabilistic per such read — not a size threshold, and not certain on the first one.
 * Measured on Windows 11 26200.9168 / OpenSSH_for_Windows_10.0p2 with `DefaultShell = cmd.exe`, by
 * replacing the copy loop with a counting reader:
 *
 *   - a 1.5s gap before any byte, which forces the first read to find nothing -> 0 bytes, 6 of 6
 *   - one byte, a 1.5s gap, then 32767 more  -> exactly 1 byte, then nothing
 *   - 32768, a 1.5s gap, then 32768 more     -> exactly 32768, then nothing
 *   - a continuous 2MB                       -> 167936 / 270336 / 372736, then nothing
 *
 * Those three 2MB death points are one payload run three times under the same conditions, which is
 * what rules out a threshold: a stream that died at a fixed point would not vary by 2x. Independently reproduced by
 * a second harness, where one 1.9MB counted read survived 39 reads to completion and another died
 * after 11 — same construct, same payload.
 *
 * A payload small enough to arrive in one burst usually presents only one read that can find the
 * stream empty (the one waiting for EOF), which is why 32KB mostly works: it still failed 15 times
 * in 120 with the host under load, and 1 in 40 on a quiet one. Neither rate is survivable across
 * the 62 execs a 1.9MB file needs — even 2.5% compounds to roughly four uploads in five failing —
 * and no chunk size helps, because the client does not control whether its bytes arrive together.
 *
 * The same host, same `DefaultShell`, same connection pattern contradicts every size-limit reading:
 * `findstr` took 2,016,000 bytes through one exec's stdin, and PowerShell 7 took 2MB. So cmd.exe is
 * not the ceiling and neither is ~50KB. Writes now go over sftp, which moves the whole payload
 * without any remote process reading a pipe; see `system-ssh-windows-write-strategy.ts` for the
 * fallback order.
 *
 * Successes are never partial. Across every run in both harnesses a failed write hung; not one
 * produced a short file, so this defect cannot silently truncate an upload.
 */

/** A staged write is materialized locally first when the source is a buffer rather than a file. */
async function withTemporaryLocalFile<T>(
  contents: Buffer,
  send: (localPath: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-win-upload-'))
  const localPath = join(directory, 'payload.bin')
  try {
    // 0600: the payload can be repository content, and tmpdir is shared on every platform.
    await writeFile(localPath, contents, { mode: 0o600 })
    return await send(localPath)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function makePosixWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): string {
  const redirection = options?.append ? '>>' : '>'
  const noclobber = !options?.append && options?.exclusive ? 'set -C; ' : ''
  return `${noclobber}cat ${redirection} ${shellEscape(remotePath)}`
}

function makeWindowsReadFileCommand(remotePath: string): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$src = [System.IO.File]::OpenRead($path)',
      '$dst = [Console]::OpenStandardOutput()',
      'try { $src.CopyTo($dst) } finally { $src.Dispose() }'
    ].join('; ')
  )
}
