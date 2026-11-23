export type RegistryPathRead = { failed: boolean; segments: string[] }

export class WindowsPathRegistryFallback {
  private readonly lastGoodBySource: (string[] | undefined)[]

  constructor(sourceCount: number) {
    this.lastGoodBySource = Array.from({ length: sourceCount })
  }

  commitReads(reads: RegistryPathRead[]): string[] | undefined {
    if (reads.length !== this.lastGoodBySource.length) {
      return undefined
    }

    const resolved = reads.map((read, index) => {
      if (!read.failed) {
        const segments = [...read.segments]
        this.lastGoodBySource[index] = segments
        return segments
      }
      const lastGood = this.lastGoodBySource[index]
      return lastGood ? [...lastGood] : undefined
    })

    return resolved.some((segments) => segments === undefined)
      ? undefined
      : resolved.flatMap((segments) => segments ?? [])
  }

  reset(): void {
    this.lastGoodBySource.fill(undefined)
  }
}
