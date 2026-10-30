import { constants, mkdtempSync, writeFileSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs'
import { access, open, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const SHELL_LIFECYCLE_STATE_ENV = '_ORCA_SHELL_LIFECYCLE_STATE'
const owned = new Map<
  string,
  { dev: number; ino: number; dirDev: number; dirIno: number; claimed: boolean }
>()

export function createShellLifecycleStateFile(): string | undefined {
  let directory: string | undefined
  try {
    directory = mkdtempSync(join(tmpdir(), 'orca-shell-lifecycle-'))
    const path = join(directory, 'state')
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
    const file = lstatSync(path)
    const dir = lstatSync(directory)
    owned.set(path, {
      dev: file.dev,
      ino: file.ino,
      dirDev: dir.dev,
      dirIno: dir.ino,
      claimed: false
    })
    return path
  } catch {
    if (directory) {
      try {
        rmdirSync(directory)
      } catch {}
    }
    return undefined
  }
}

export function claimShellLifecycleStateFile(path: string | undefined): string | undefined {
  const owner = path ? owned.get(path) : undefined
  if (!owner) {
    return undefined
  }
  owner.claimed = true
  return path
}

export function releaseShellLifecycleStateFile(
  path: string | undefined,
  unclaimedOnly = false
): void {
  const owner = path ? owned.get(path) : undefined
  if (!path || !owner || (unclaimedOnly && owner.claimed)) {
    return
  }
  owned.delete(path)
  try {
    const dir = lstatSync(dirname(path))
    if (dir.dev !== owner.dirDev || dir.ino !== owner.dirIno) {
      return
    }
    const file = lstatSync(path)
    if (file.dev !== owner.dev || file.ino !== owner.ino) {
      return
    }
    unlinkSync(path)
    rmdirSync(dirname(path))
  } catch {}
}

export async function withShellLifecycleStateFile<T>(
  env: Record<string, string>,
  operation: () => Promise<T>
): Promise<T> {
  const path = env[SHELL_LIFECYCLE_STATE_ENV]
  try {
    return await operation()
  } finally {
    releaseShellLifecycleStateFile(path, true)
  }
}

export async function readShellLifecycleStateFile(
  path: string | undefined
): Promise<{ value: string; ageMs: number } | null> {
  if (!path || process.platform === 'win32') {
    return null
  }
  try {
    const dir = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const parent = await dir.stat()
      if (
        !parent.isDirectory() ||
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o077) !== 0
      ) {
        return null
      }
      await access(path, constants.W_OK)
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const before = await file.stat({ bigint: true })
        if (
          !before.isFile() ||
          before.size > 512n ||
          before.uid !== BigInt(parent.uid) ||
          (before.mode & 0o077n) !== 0n ||
          (before.mode & 0o200n) === 0n
        ) {
          return null
        }
        const buffer = Buffer.alloc(513)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const after = await file.stat({ bigint: true })
        const current = await lstat(path, { bigint: true })
        const currentParent = await lstat(dirname(path))
        if (
          current.dev !== after.dev ||
          current.ino !== after.ino ||
          currentParent.dev !== parent.dev ||
          currentParent.ino !== parent.ino ||
          currentParent.mode !== parent.mode ||
          currentParent.uid !== parent.uid ||
          current.size !== after.size ||
          current.mtimeNs !== after.mtimeNs ||
          current.ctimeNs !== after.ctimeNs
        ) {
          return null
        }
        if (
          before.size !== BigInt(bytesRead) ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        ) {
          return null
        }
        const ageMs = Date.now() - Math.floor(Number(after.mtimeNs) / 1_000_000)
        if (!Number.isFinite(ageMs) || ageMs < 0) {
          return null
        }
        return { value: buffer.toString('utf8', 0, bytesRead), ageMs }
      } finally {
        await file.close()
      }
    } finally {
      await dir.close()
    }
  } catch {
    return null
  }
}
