import type { SFTPWrapper } from 'ssh2'
import { SshDirectoryTransferBudget } from './ssh-directory-transfer-budget'

type SftpDirectoryEntry = {
  filename: string
  attrs?: {
    isDirectory?: () => boolean
  }
}

export async function removeDirectorySftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const budget = new SshDirectoryTransferBudget()
  budget.recordPath(remoteDir, 0, { countEntry: false })
  await removeDirectorySftpWithinBudget(sftp, remoteDir, budget, 0)
}

async function removeDirectorySftpWithinBudget(
  sftp: SFTPWrapper,
  remoteDir: string,
  budget: SshDirectoryTransferBudget,
  depth: number
): Promise<void> {
  const handle = await opendirSftp(sftp, remoteDir)
  const normalizedRemoteDir = remoteDir.replace(/\/+$/, '')
  let completed = false
  try {
    for (;;) {
      const entries = await readdirSftp(sftp, handle)
      if (!entries) {
        break
      }
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') {
          continue
        }
        const childPath = `${normalizedRemoteDir}/${entry.filename}`
        budget.recordPath(childPath, depth + 1)
        await (entry.attrs?.isDirectory?.()
          ? removeDirectorySftpWithinBudget(sftp, childPath, budget, depth + 1)
          : unlinkSftp(sftp, childPath))
      }
    }
    completed = true
  } finally {
    await closeSftpHandle(sftp, handle).catch((error: unknown) => {
      if (completed) {
        throw error
      }
    })
  }
  await rmdirSftp(sftp, remoteDir)
}

function opendirSftp(sftp: SFTPWrapper, remoteDir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.opendir(remoteDir, (err, handle) => {
      if (err) {
        reject(err)
        return
      }
      resolve(handle)
    })
  })
}

function readdirSftp(sftp: SFTPWrapper, handle: Buffer): Promise<SftpDirectoryEntry[] | null> {
  return new Promise((resolve, reject) => {
    sftp.readdir(handle, (err, entries) => {
      if ((err as { code?: number } | undefined)?.code === 1) {
        resolve(null)
        return
      }
      if (err) {
        reject(err)
        return
      }
      resolve((entries ?? []) as SftpDirectoryEntry[])
    })
  })
}

function closeSftpHandle(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function unlinkSftp(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function rmdirSftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remoteDir, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}
