import { constants, createWriteStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
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
    await writeBufferViaSystemSshWindows(target, remotePath, contents, options)
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

    const isWindows = options?.hostPlatform && isWindowsRemoteHost(options.hostPlatform)
    const channel = spawnSystemSshCommand(
      target,
      isWindows
        ? makeWindowsWriteFileCommand(remotePath, options)
        : makePosixWriteFileCommand(remotePath, options),
      {
        wrapCommand: !isWindows,
        ...getSystemSshBuildArgsFromOperationOptions(options)
      }
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

async function writeBufferViaSystemSshWindows(
  target: SshTarget,
  remotePath: string,
  contents: Buffer,
  options: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(target, makeWindowsWriteFileCommand(remotePath, options), {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, `write ${remotePath}`)
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(contents)
  }
  await closePromise
}

function makeWindowsWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): string {
  const fileMode = options?.append ? 'Append' : options?.exclusive ? 'CreateNew' : 'Create'
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$parent = [System.IO.Path]::GetDirectoryName($path)',
      'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '$inputStream = [Console]::OpenStandardInput()',
      `$outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::${fileMode}, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
      'try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }'
    ].join('; ')
  )
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
