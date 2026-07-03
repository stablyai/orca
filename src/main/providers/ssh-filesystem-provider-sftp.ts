import type { SFTPWrapper, Stats } from 'ssh2'
import type { FileStat } from './types'

export function fileStatFromSftpStats(stats: Stats): FileStat {
  let type: FileStat['type'] = 'file'
  if (stats.isDirectory()) {
    type = 'directory'
  } else if (stats.isSymbolicLink()) {
    type = 'symlink'
  }
  const maybeNlink = (stats as Stats & { nlink?: unknown }).nlink
  return {
    size: stats.size,
    type,
    mtime: stats.mtime * 1000,
    ...(typeof maybeNlink === 'number' ? { nlink: maybeNlink } : {})
  }
}

export function lstatViaSftp(sftp: SFTPWrapper, filePath: string): Promise<FileStat> {
  return new Promise((resolve, reject) => {
    sftp.lstat(filePath, (err, stats) => {
      if (err) {
        reject(err)
        return
      }
      resolve(fileStatFromSftpStats(stats))
    })
  })
}

export function fastGetViaSftp(
  sftp: SFTPWrapper,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(sourcePath, destinationPath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}
