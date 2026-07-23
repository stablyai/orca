import { constants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join as pathJoin, relative, sep } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { SshDirectoryTransferBudget } from './ssh-directory-transfer-budget'

export { removeDirectorySftp } from './sftp-directory-removal'

export function mkdirSftp(
  sftp: SFTPWrapper,
  path: string,
  options?: { allowExisting?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      // Why: SFTP status code 4 (SSH_FX_FAILURE) is a generic code that
      // OpenSSH returns for "already exists," but could also cover other
      // failures (e.g. permission denied on parent). We accept this ambiguity
      // because the next operation (write/recurse) will surface the real error.
      if (err && ((err as { code?: number }).code !== 4 || options?.allowExisting === false)) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

export function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options?: { exclusive?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let readStream: ReadStream | null = null
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null
    let writeStream: ReturnType<SFTPWrapper['createWriteStream']> | null = null

    const cleanupListeners = (): void => {
      writeStream?.off('close', onWriteClose)
      writeStream?.off('error', onWriteError)
      readStream?.off('error', onReadError)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      readStream?.destroy()
      writeStream?.destroy()
      void fileHandle?.close().catch(() => {})
      fn(val as never)
    }
    const onWriteClose = (): void => settle(resolve)
    const onWriteError = (err: Error): void => settle(reject, err)
    const onReadError = (err: Error): void => settle(reject, err)

    void open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      .then(async (handle) => {
        if (settled) {
          void handle.close().catch(() => {})
          return
        }
        fileHandle = handle
        const statResult = await lstat(localPath)
        if (statResult.isSymbolicLink() || !statResult.isFile()) {
          throw new Error(`Unsupported upload source: ${localPath}`)
        }
        const openedStat = await handle.stat()
        if (
          !openedStat.isFile() ||
          openedStat.size !== statResult.size ||
          (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
          (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
        ) {
          throw new Error(`File changed during upload: ${localPath}`)
        }
        // Why: validate the local source before creating the remote write
        // target, so rejected sources do not leave empty files behind.
        writeStream = sftp.createWriteStream(remotePath, {
          flags: options?.exclusive ? 'wx' : 'w'
        })
        writeStream.on('close', onWriteClose)
        writeStream.on('error', onWriteError)
        readStream = handle.createReadStream()
        readStream.on('error', onReadError)
        readStream.pipe(writeStream)
      })
      .catch((err: unknown) => settle(reject, err))
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

    const cleanupListeners = (): void => {
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

export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  rootRealPath = localDir,
  options?: { exclusive?: boolean }
): Promise<void> {
  const entries = await collectLocalUploadEntries(localDir, remoteDir, rootRealPath)
  for (const entry of entries) {
    await assertLocalUploadPathInsideRoot(rootRealPath, entry.localPath)
    const statResult = await lstat(entry.localPath)
    if (statResult.isSymbolicLink() || statResult.isDirectory() !== (entry.kind === 'directory')) {
      throw new Error(`Upload source changed during transfer: ${entry.localPath}`)
    }
    await (entry.kind === 'directory'
      ? mkdirSftp(sftp, entry.remotePath, { allowExisting: !options?.exclusive })
      : uploadFile(sftp, entry.localPath, entry.remotePath, {
          exclusive: options?.exclusive
        }))
  }
}

type LocalUploadEntry = {
  kind: 'directory' | 'file'
  localPath: string
  remotePath: string
}

async function collectLocalUploadEntries(
  localDir: string,
  remoteDir: string,
  rootRealPath: string
): Promise<LocalUploadEntry[]> {
  const budget = new SshDirectoryTransferBudget()
  const collected: LocalUploadEntry[] = []
  const pending = [{ localDir, remoteDir, depth: 0 }]
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  budget.recordPath(remoteDir, 0, { countEntry: false })
  budget.recordPath(localDir, 0, { countEntry: false })

  while (pending.length > 0) {
    const current = pending.pop()!
    const handle = await opendir(current.localDir)
    try {
      for await (const entry of handle) {
        const localPath = pathJoin(current.localDir, entry.name)
        const remotePath = `${current.remoteDir}/${entry.name}`
        const depth = current.depth + 1
        budget.recordPath(remotePath, depth)
        budget.recordPath(localPath, depth, { countEntry: false })
        await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
        const statResult = await lstat(localPath)
        if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
          continue
        }
        const kind = statResult.isDirectory() ? 'directory' : 'file'
        collected.push({ kind, localPath, remotePath })
        if (kind === 'directory') {
          pending.push({ localDir: localPath, remoteDir: remotePath, depth })
        }
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  return collected
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

/**
 * Check whether a path exists on the remote via SFTP lstat.
 * Returns true if the path exists (file, directory, or symlink).
 */
export function sftpPathExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (err) => {
      if (!err) {
        resolve(true)
        return
      }
      // Why: SFTP status code 2 = SSH_FX_NO_SUCH_FILE — the path does not
      // exist, which is the expected "no collision" signal for deconfliction.
      if ((err as { code?: number }).code === 2) {
        resolve(false)
        return
      }
      reject(err)
    })
  })
}
