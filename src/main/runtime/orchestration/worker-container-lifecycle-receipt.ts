import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

const UNREADABLE_RECEIPT_PREFIX = 'worker_lifecycle_receipt_unreadable'

export function isWorkerLifecycleReceiptUnreadable(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith(`${UNREADABLE_RECEIPT_PREFIX}:`)
}

function unreadableReceiptError(error: unknown): Error {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN'
  return new Error(`${UNREADABLE_RECEIPT_PREFIX}:${code}`)
}

function isInvalidReceiptError(error: unknown): boolean {
  if (error instanceof Error && error.message === 'worker_lifecycle_receipt_invalid') {
    return true
  }
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP')
}

export function readBoundedWorkerLifecycleReceipt(path: string, maxBytes: number): string {
  let descriptor: number | undefined
  let failed = false
  let failure: unknown
  let result: string | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    const pathStat = lstatSync(path)
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino ||
      stat.size > maxBytes
    ) {
      throw new Error('worker_lifecycle_receipt_invalid')
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null)
      if (count === 0) {
        break
      }
      offset += count
    }
    if (offset !== bytes.length) {
      throw new Error('worker_lifecycle_receipt_invalid')
    }
    result = bytes.toString('utf8')
  } catch (error) {
    failed = true
    failure = error
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch (error) {
      throw unreadableReceiptError(error)
    }
  }
  if (isInvalidReceiptError(failure)) {
    throw new Error('worker_lifecycle_receipt_invalid')
  }
  if (failed) {
    throw unreadableReceiptError(failure)
  }
  return result as string
}
