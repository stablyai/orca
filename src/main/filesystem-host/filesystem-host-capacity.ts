export type FilesystemHostAdmissionClass = 'foreground' | 'background'
export const MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN = 8

export class FilesystemHostCapacity {
  private reserved = 0

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 2) {
      throw new Error('Filesystem host capacity must be at least two')
    }
  }

  reserve(admission: FilesystemHostAdmissionClass): (() => void) | null {
    const limit = admission === 'background' ? this.maximum - 1 : this.maximum
    if (this.reserved >= limit) {
      return null
    }
    this.reserved++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.reserved--
      }
    }
  }

  get reservedCount(): number {
    return this.reserved
  }
}

export const processWideFilesystemHostCapacity = new FilesystemHostCapacity(
  MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN
)
