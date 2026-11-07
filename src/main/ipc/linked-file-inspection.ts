import { lstat, open, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { classifyLinkedFile, type LinkedFileAction } from './launchable-file-type'

const HEAD_BYTES = 4096
const MAX_SYMLINK_HOPS = 32

async function symlinkChain(pathValue: string): Promise<string[]> {
  const names = [pathValue]
  let current = pathValue
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    if (!(await lstat(current)).isSymbolicLink()) {
      break
    }
    current = resolve(dirname(current), await readlink(current))
    names.push(current)
  }
  return names
}

async function readHead(pathValue: string): Promise<Uint8Array> {
  const handle = await open(pathValue, 'r')
  try {
    const buffer = new Uint8Array(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Classify the file a link points at, following symlinks. Fails closed: what cannot be inspected is revealed. */
export async function inspectLinkedFile(pathValue: string): Promise<LinkedFileAction> {
  try {
    const names = await symlinkChain(pathValue)
    // Some Windows volumes (RAM disks, certain network drives) refuse realpath; the walked chain still names the target.
    const resolved = await realpath(pathValue).catch(() => names.at(-1) ?? pathValue)
    names.push(resolved)
    const stats = await stat(resolved)
    return classifyLinkedFile({
      names,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      mode: stats.mode,
      head: stats.isFile() ? await readHead(resolved) : new Uint8Array()
    })
  } catch {
    return 'reveal'
  }
}
