import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshTarget } from '../../../shared/ssh-types'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../ssh-remote-platform'
import { powerShellCommand } from '../ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import {
  awaitWithSystemSshAbort,
  throwIfAborted,
  waitForChannelClose
} from './system-ssh-operation-lifecycle'
import {
  writeWindowsRemoteFile,
  type WindowsWriteSource
} from './system-ssh-windows-write-strategy'

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
    : `cat ${quotePosixShell(remotePath)}`
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
      const source: WindowsWriteSource = {
        totalBytes: openedStat.size,
        readChunk: async (offset, maxBytes) => {
          const buffer = Buffer.allocUnsafe(Math.min(maxBytes, openedStat.size - offset))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          return buffer.subarray(0, bytesRead)
        },
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

/** #16432: on Windows 11/OpenSSH 10.0p2, PowerShell 5.1 stdin can hang permanently when a read finds an empty pipe, losing data and EOF. This is per read, not a size limit: even 32KiB failed 15/120 under load; identical 2MB writes hung at different offsets. findstr and PowerShell 7 accepted 2MB on the same host. Prefer SFTP, then PowerShell 7, with bounded 5.1 last (system-ssh-windows-write-strategy.ts). Observed failures hung rather than reporting successful short writes. */

/** SFTP requires a local file even when the source is an in-memory buffer. */
async function withTemporaryLocalFile<T>(
  contents: Buffer,
  send: (localPath: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-win-upload-'))
  const localPath = join(directory, 'payload.bin')
  try {
    // Repository payloads in shared temp directories must be private from creation.
    await writeFile(localPath, contents, { mode: 0o600 })
    return await send(localPath)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export function makePosixWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): string {
  const redirection = options?.append ? '>>' : '>'
  const noclobber = !options?.append && options?.exclusive ? 'set -C; ' : ''
  return `${noclobber}cat ${redirection} ${quotePosixShell(remotePath)}`
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
