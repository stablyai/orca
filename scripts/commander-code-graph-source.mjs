import { constants } from 'node:fs'
import { open, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { maxGraphFileBytes, readIndexGraphFiles } from './commander-code-graph-index.mjs'

const maxTotalBytes = 8 * 1024 * 1024

async function canVerifyOpenFiles(root) {
  if (process.platform !== 'linux') {
    return false
  }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY).catch(() => null)
  if (!directory) {
    return false
  }
  try {
    return (await readlink(`/proc/self/fd/${directory.fd}`).catch(() => null)) === root
  } finally {
    await directory.close()
  }
}

async function readSource(root, file, available) {
  const path = join(root, file)
  if ((await realpath(path)) !== path) {
    return null
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    if ((await readlink(`/proc/self/fd/${handle.fd}`)) !== path) {
      return null
    }
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxGraphFileBytes || stat.size > available) {
      return null
    }
    const bytes = Buffer.alloc(stat.size)
    let n = 0
    while (n < bytes.length) {
      const { bytesRead } = await handle.read(bytes, n, bytes.length - n)
      if (!bytesRead) {
        break
      }
      n += bytesRead
    }
    return bytes.subarray(0, n)
  } finally {
    await handle.close()
  }
}

async function readTrackedFile(root, file, available) {
  try {
    return await readSource(root, file, available)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) {
      return null
    }
    throw error
  }
}

export async function createGraphSourceReader(root, indexed) {
  let bytesLeft = maxTotalBytes
  const workingTree = await canVerifyOpenFiles(root)
  async function readBatch(paths) {
    if (!workingTree) {
      const blobs = await readIndexGraphFiles(root, paths, indexed, bytesLeft)
      for (const data of blobs.values()) {
        bytesLeft -= data.length
      }
      return blobs
    }
    const files = new Map()
    for (const path of paths) {
      const data = await readTrackedFile(root, path, bytesLeft)
      if (data) {
        files.set(path, data)
        bytesLeft -= data.length
      }
    }
    return files
  }
  return {
    sourceMode: workingTree ? 'working-tree' : 'index',
    readBatch,
    async *sources(paths) {
      const batchSize = workingTree ? 1 : 16
      for (let start = 0; start < paths.length && bytesLeft > 0; start += batchSize) {
        const batch = paths.slice(start, start + batchSize)
        const files = await readBatch(batch)
        for (const path of batch) {
          yield [path, files.get(path)]
        }
      }
    }
  }
}
