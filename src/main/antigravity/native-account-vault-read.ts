import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { restrictWindowsPath } from '../../shared/secure-path-windows-acl'
import {
  remainingAccountOperationMs,
  type AntigravityAccountOperation
} from './native-account-operation'

export const MAX_VAULT_BYTES = 4 * 1024 * 1024
/** One byte past the checked size reveals a same-metadata append, but never past the cap. */
export function vaultReadByteBudget(checkedSize: number): number {
  return Math.min(checkedSize + 1, MAX_VAULT_BYTES)
}
export function sameVaultFile(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.uid === second.uid &&
    first.mode === second.mode &&
    first.nlink === second.nlink &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  )
}
function privateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > MAX_VAULT_BYTES ||
    (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  ) {
    throw new Error('Unsafe Antigravity vault file')
  }
}
export async function readAntigravityAccountVault(
  path: string,
  before: Stats,
  operation: AntigravityAccountOperation
): Promise<Buffer> {
  remainingAccountOperationMs(operation)
  privateFile(before)
  const parent = dirname(path)
  const directory = await lstat(parent)
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))
  ) {
    throw new Error('Unsafe Antigravity vault directory')
  }
  if (
    process.platform === 'win32' &&
    (!(await restrictWindowsPath(parent, true, operation)) ||
      !(await restrictWindowsPath(path, false, operation)))
  ) {
    throw new Error('Unsafe Antigravity vault ACL')
  }
  remainingAccountOperationMs(operation)
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const file = await open(path, flags)
  try {
    const opened = await file.stat()
    privateFile(opened)
    if (!sameVaultFile(before, opened)) {
      throw new Error('Antigravity vault changed before reading')
    }
    const buffer = Buffer.alloc(vaultReadByteBudget(opened.size))
    let total = 0
    while (total < buffer.length) {
      remainingAccountOperationMs(operation)
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) {
        break
      }
      total += bytesRead
    }
    const after = await file.stat()
    const pathAfter = await lstat(path)
    const parentAfter = await lstat(parent)
    if (
      total !== opened.size ||
      !sameVaultFile(opened, after) ||
      !sameVaultFile(opened, pathAfter) ||
      directory.ino !== parentAfter.ino ||
      directory.dev !== parentAfter.dev ||
      parentAfter.isSymbolicLink() ||
      !parentAfter.isDirectory()
    ) {
      throw new Error('Antigravity vault changed while reading')
    }
    remainingAccountOperationMs(operation)
    return buffer.subarray(0, total)
  } finally {
    await file.close()
  }
}
