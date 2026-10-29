export type FilesystemHostAdmissionClass = 'foreground' | 'background'
export const MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN = 8

export class FilesystemHostCapacity {
  private reserved = 0
  private classifiers = 0

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 2) {
      throw new Error('Filesystem host capacity must be at least two')
    }
  }

  reserve(admission: FilesystemHostAdmissionClass, classification = false): (() => void) | null {
    if (classification && !this.hasClassifierCapacity) {
      return null
    }
    const limit = admission === 'background' ? this.maximum - 1 : this.maximum
    if (this.reserved >= limit) {
      return null
    }
    this.reserved++
    if (classification) {
      this.classifiers++
    }
    let released = false
    return () => {
      if (!released) {
        released = true
        this.reserved--
        if (classification) {
          this.classifiers--
        }
      }
    }
  }

  get reservedCount(): number {
    return this.reserved
  }

  get hasClassifierCapacity(): boolean {
    // Unknown roots can share a hung mount; retain healthy background and foreground capacity.
    return this.classifiers < Math.max(1, Math.min(4, this.maximum - 2))
  }
}

export const processWideFilesystemHostCapacity = new FilesystemHostCapacity(
  MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN
)
