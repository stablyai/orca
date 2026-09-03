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
    await writeWindowsBytesViaSystemSsh(
      target,
      remotePath,
      contents.length,
      (offset, maxBytes) =>
        Promise.resolve(contents.subarray(offset, Math.min(offset + maxBytes, contents.length))),
      options
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
      // #16432: a Windows host cannot take a whole file through one stdin, however the local side
      // paces it — see WINDOWS_STDIN_WRITE_CHUNK_BYTES. This is the path that carries the large
      // files, so it is the one that has to be chunked and bounded.
      await writeWindowsBytesViaSystemSsh(
        target,
        remotePath,
        openedStat.size,
        async (offset, maxBytes) => {
          const buffer = Buffer.allocUnsafe(Math.min(maxBytes, openedStat.size - offset))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          return buffer.subarray(0, bytesRead)
        },
        options
      )
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
 * #16432: Windows PowerShell 5.1 stops draining a redirected stdin over a non-pty ssh exec
 * somewhere between 50KB and 1MB, depending on the host's `DefaultShell`, and it hangs rather than
 * failing. The reporter measured that on both constructs he tried — `[Console]::In.ReadToEnd()` and
 * `new IO.StreamReader([Console]::OpenStandardInput())`, the latter reading incrementally, which is
 * why the limit cannot be attributed to materializing the payload. `Stream.CopyTo` reads the same
 * `[Console]::OpenStandardInput()` object with the same incremental `Read` loop, so nothing in it
 * escapes that limit either: no single write may exceed what one stdin is known to carry.
 *
 * 32KB is an order of magnitude under the low end of the measured range, and under 50KB, which the
 * reporter measured succeeding against a stream reader on the worse of the two `DefaultShell`
 * settings.
 */
export const WINDOWS_STDIN_WRITE_CHUNK_BYTES = 32 * 1024

/** No Windows stdin write should ever outlive this; a wedged PowerShell never closes on its own. */
export const WINDOWS_STDIN_WRITE_TIMEOUT_MS = 60_000

/** Suffix for the path a multi-exec Windows write lands on before it is published by rename. */
export const WINDOWS_STAGED_WRITE_SUFFIX = '.orca-partial'

/**
 * Splits one logical Windows write into stdin-sized execs.
 *
 * A write that needs more than one exec cannot land on the destination directly: a chunk failing
 * mid-file would leave a truncated artifact under the real name with nothing marking it incomplete,
 * and the retry would then meet its own leftovers — under `exclusive` the retry's `CreateNew` fails
 * on them. Multi-exec creates therefore land on a staging path and are published by a rename, which
 * is also where `exclusive` is enforced: once, at the destination, instead of smeared across the
 * first chunk. A caller-requested append cannot be staged without reading the remote file back, so
 * it keeps writing straight through, as its own protocol already implies.
 */
async function writeWindowsBytesViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  totalBytes: number,
  readChunk: (offset: number, maxBytes: number) => Promise<Buffer>,
  options: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const staged = !options.append && totalBytes > WINDOWS_STDIN_WRITE_CHUNK_BYTES
  const writePath = staged ? `${remotePath}${WINDOWS_STAGED_WRITE_SUFFIX}` : remotePath
  let offset = 0
  // An empty write still has to run: it is what creates (or truncates) the file.
  do {
    const chunk = await readChunk(offset, WINDOWS_STDIN_WRITE_CHUNK_BYTES)
    if (chunk.length === 0 && offset < totalBytes) {
      throw new Error(`Source ran short during upload of ${remotePath}`)
    }
    await writeWindowsChunkViaSystemSsh(
      target,
      writePath,
      chunk,
      {
        ...options,
        append: staged ? offset > 0 : options.append === true || offset > 0,
        exclusive: staged ? false : options.exclusive === true && offset === 0
      },
      offset
    )
    offset += chunk.length
  } while (offset < totalBytes)
  if (staged) {
    await publishWindowsStagedWrite(target, writePath, remotePath, options)
  }
}

async function writeWindowsChunkViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  chunk: Buffer,
  options: SystemSshWriteBufferOptions,
  offset: number
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(target, makeWindowsWriteFileCommand(remotePath, options), {
    wrapCommand: false,
    ...getSystemSshBuildArgsFromOperationOptions(options)
  })
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(
      channel,
      `write ${remotePath} at offset ${offset}`,
      WINDOWS_STDIN_WRITE_TIMEOUT_MS
    )
  )
  if (!options.signal?.aborted) {
    channel.stdin.end(chunk)
  }
  await closePromise
}

async function publishWindowsStagedWrite(
  target: SshTarget,
  stagingPath: string,
  remotePath: string,
  options: SystemSshWriteBufferOptions
): Promise<void> {
  throwIfAborted(options.signal)
  const channel = spawnSystemSshCommand(
    target,
    makeWindowsPublishStagedFileCommand(stagingPath, remotePath, options.exclusive === true),
    { wrapCommand: false, ...getSystemSshBuildArgsFromOperationOptions(options) }
  )
  const closePromise = awaitWithSystemSshAbort(
    options.signal,
    () => channel.close(),
    waitForChannelClose(channel, `publish ${remotePath}`, WINDOWS_STDIN_WRITE_TIMEOUT_MS)
  )
  if (!options.signal?.aborted) {
    channel.stdin.end()
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

// `File::Move` throws when the destination exists, which is exactly the exclusive contract; the
// non-exclusive caller asked to replace, so it deletes first (a no-op on an absent path).
function makeWindowsPublishStagedFileCommand(
  stagingPath: string,
  remotePath: string,
  exclusive: boolean
): string {
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$staging = ${powerShellLiteral(stagingPath)}`,
      `$path = ${powerShellLiteral(remotePath)}`,
      ...(exclusive ? [] : ['[System.IO.File]::Delete($path)']),
      '[System.IO.File]::Move($staging, $path)'
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
