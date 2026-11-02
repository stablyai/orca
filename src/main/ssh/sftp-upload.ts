import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join as pathJoin, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { SFTPWrapper } from 'ssh2'
import { createSshOperationAbortError } from './connection/ssh-exec-options'
import { SFTP_UPLOAD_IN_FLIGHT_BYTES, uploadFileWithWindow } from './sftp-file-upload'
import { latchLateSftpStreamErrors } from './sftp-stream-late-error'
import {
  createLinkedSshFileTransferSignal,
  raceSftpFileTransferWithAbort
} from './ssh-file-transfer-abort'

export { SFTP_UPLOAD_IN_FLIGHT_BYTES, uploadFile } from './sftp-file-upload'

function mkdirSftp(
  sftp: SFTPWrapper,
  path: string,
  options?: { allowExisting?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      // Status 4 can mean already-exists or another failure; allow it and let the next write/recurse expose the actual refusal.
      if (err && ((err as { code?: number }).code !== 4 || options?.allowExisting === false)) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

export function uploadBuffer(
  sftp: SFTPWrapper,
  buffer: Buffer,
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const writeStream = sftp.createWriteStream(remotePath, {
      flags: options?.append ? 'a' : options?.exclusive ? 'wx' : 'w'
    })
    const lateErrors = latchLateSftpStreamErrors(writeStream, remotePath)

    const cleanupListeners = (): void => {
      lateErrors.markTransferSettled()
      writeStream.off('close', onClose)
      writeStream.off('error', onError)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      writeStream.destroy()
      fn(val as never)
    }
    const onClose = (): void => settle(resolve)
    const onError = (err: Error): void => settle(reject, err)

    writeStream.on('close', onClose)
    writeStream.on('error', onError)
    writeStream.end(buffer)
  })
}

export function writeStringViaSftp(
  sftp: SFTPWrapper,
  remotePath: string,
  contents: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath)
    const lateErrors = latchLateSftpStreamErrors(ws, remotePath)
    let settled = false
    const cleanup = (): void => {
      lateErrors.markTransferSettled()
      sftp.removeListener('error', onError)
      ws.removeListener('close', onClose)
      ws.removeListener('error', onError)
    }
    const onClose = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(err)
    }
    // Settle this write before the session's late-error swallower sees the error.
    sftp.prependOnceListener('error', onError)
    ws.once('close', onClose)
    ws.once('error', onError)
    ws.end(contents)
  })
}

export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  root = localDir,
  options?: { exclusive?: boolean; signal?: AbortSignal; endSession?: () => void }
): Promise<void> {
  options?.signal?.throwIfAborted()
  const failure = new AbortController()
  const linked = createLinkedSshFileTransferSignal(
    options?.signal ? [options.signal, failure.signal] : [failure.signal]
  )
  const active = new Set<Promise<void>>()
  let reservedBytes = 0
  let capacityWaiter: (() => void) | undefined
  const wakeProducer = (): void => {
    const waiter = capacityWaiter
    capacityWaiter = undefined
    waiter?.()
  }
  linked.signal.addEventListener('abort', wakeProducer, { once: true })
  let firstError: Error | undefined
  let sessionClosed = false
  const onSessionClose = (): void => {
    sessionClosed = true
  }
  sftp.prependOnceListener('close', onSessionClose)
  const fail = (error: unknown): void => {
    if (!linked.signal.aborted) {
      firstError = error instanceof Error ? error : new Error(String(error))
      failure.abort(firstError)
    }
  }
  const upload = async (
    localPath: string,
    remotePath: string,
    size: number,
    rootRealPath: string
  ): Promise<void> => {
    const window = Math.min(SFTP_UPLOAD_IN_FLIGHT_BYTES, Math.max(64 * 1024, size))
    while (active.size >= 4 || reservedBytes + window > SFTP_UPLOAD_IN_FLIGHT_BYTES) {
      linked.signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        capacityWaiter = resolve
      })
    }
    await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
    linked.signal.throwIfAborted()
    reservedBytes += window
    const transfer = uploadFileWithWindow(sftp, localPath, remotePath, window, {
      exclusive: options?.exclusive,
      signal: linked.signal
    })
      .catch(fail)
      .finally(() => {
        reservedBytes -= window
        active.delete(transfer)
        wakeProducer()
      })
    active.add(transfer)
  }
  const run = (async (): Promise<void> => {
    try {
      // Canonicalize root like entries; symlinks, junctions and Windows 8.3 paths otherwise look escaped.
      const rootRealPath = await realpath(root)
      await uploadDirectoryWithinRoot(sftp, localDir, remoteDir, rootRealPath, {
        ...options,
        signal: linked.signal,
        upload: (localPath, remotePath, size) => upload(localPath, remotePath, size, rootRealPath)
      })
    } catch (error) {
      fail(error)
    }
    await Promise.all(active)
    linked.signal.throwIfAborted()
  })()
  try {
    await raceSftpFileTransferWithAbort(
      run,
      linked.signal,
      (onClose) => {
        if (sessionClosed) {
          onClose()
        } else {
          sftp.once('close', onClose)
        }
        if (options?.endSession) {
          options.endSession()
        } else {
          sftp.end()
        }
        return () => sftp.removeListener('close', onClose)
      },
      () => firstError ?? createSshOperationAbortError()
    )
  } finally {
    sftp.removeListener('close', onSessionClose)
    linked.signal.removeEventListener('abort', wakeProducer)
    wakeProducer()
    linked.dispose()
  }
}

async function uploadDirectoryWithinRoot(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  rootRealPath: string,
  options: {
    exclusive?: boolean
    signal: AbortSignal
    upload: (localPath: string, remotePath: string, size: number) => Promise<void>
  }
): Promise<void> {
  options.signal.throwIfAborted()
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  const entries = await readdir(localDir, { withFileTypes: true })
  for (const entry of entries) {
    options.signal.throwIfAborted()
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = `${remoteDir}/${entry.name}`
    await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
    const statResult = await lstat(localPath)
    options.signal.throwIfAborted()

    // Reject symlinks/special files again after pre-scan to close replacement races that could upload unrelated local data.
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }

    if (statResult.isDirectory()) {
      await mkdirSftp(sftp, remotePath, { allowExisting: !options?.exclusive })
      await uploadDirectoryWithinRoot(sftp, localPath, remotePath, rootRealPath, options)
    } else {
      await options.upload(localPath, remotePath, statResult.size)
    }
  }
}

export async function removeDirectorySftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const entries = (await promisify(sftp.readdir.bind(sftp))(remoteDir)) ?? []
  const normalizedRemoteDir = remoteDir.replace(/\/+$/, '')
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') {
      continue
    }
    const childPath = `${normalizedRemoteDir}/${entry.filename}`
    await (entry.attrs?.isDirectory?.()
      ? removeDirectorySftp(sftp, childPath)
      : promisify(sftp.unlink.bind(sftp))(childPath))
  }
  await promisify(sftp.rmdir.bind(sftp))(remoteDir)
}

async function assertLocalUploadPathInsideRoot(
  rootRealPath: string,
  candidatePath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root: ${candidatePath}`)
  }
}
