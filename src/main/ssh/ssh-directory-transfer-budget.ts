export const TRANSFER_PLAN_MAX_RETAINED_BYTES = 32 * 1024 * 1024
export const TRANSFER_PLAN_MAX_ENTRIES = 100_000
export const TRANSFER_PLAN_MAX_DEPTH = 256
export const TRANSFER_PLAN_MAX_PATH_BYTES = 64 * 1024

export class DirectoryTransferCapacityError extends Error {
  readonly code = 'directory_transfer_capacity'
  constructor() {
    super(
      'Folder transfer plan is too large to retain safely. Transfer smaller folders separately.'
    )
    this.name = 'DirectoryTransferCapacityError'
  }
}

export class DirectoryTransferBudget {
  private retainedBytes = 0
  private entries = 0

  record(paths: readonly string[], depth: number): number {
    if (depth > TRANSFER_PLAN_MAX_DEPTH || this.entries >= TRANSFER_PLAN_MAX_ENTRIES) {
      throw new DirectoryTransferCapacityError()
    }
    let bytes = 256
    for (const path of paths) {
      if (Buffer.byteLength(path) > TRANSFER_PLAN_MAX_PATH_BYTES) {
        throw new DirectoryTransferCapacityError()
      }
      bytes += path.length * 2
    }
    if (this.retainedBytes + bytes > TRANSFER_PLAN_MAX_RETAINED_BYTES) {
      throw new DirectoryTransferCapacityError()
    }
    this.entries += 1
    this.retainedBytes += bytes
    return bytes
  }

  release(bytes: number, entries: number): void {
    this.retainedBytes -= bytes
    this.entries -= entries
  }
}
