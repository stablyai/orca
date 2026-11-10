export type TerminalHistoryWriterCapture = {
  current: () => boolean
  release: () => void
}
type Capture = { valid: boolean; persistenceReady: Promise<unknown> }

/** Unresolved retirements remember takeovers even after the successor releases its writer. */
export class TerminalHistoryWriterHandoff {
  private readonly captures = new Map<string, Set<Capture>>()
  private readonly admissions = new Map<string, Set<object>>()

  capture(
    id: string,
    valid: boolean,
    persistenceReady: Promise<unknown>
  ): TerminalHistoryWriterCapture {
    const capture = { valid: valid && !this.admissions.has(id), persistenceReady }
    const captures = this.captures.get(id) ?? new Set<Capture>()
    this.captures.set(id, captures)
    captures.add(capture)
    return {
      current: () => capture.valid && captures.has(capture),
      release: () => {
        captures.delete(capture)
        if (!captures.size && this.captures.get(id) === captures) {
          this.captures.delete(id)
        }
      }
    }
  }

  revoke(id: string): void {
    for (const capture of this.captures.get(id) ?? []) {
      capture.valid = false
    }
  }

  admitting(id: string): boolean {
    return this.admissions.has(id)
  }

  admit(id: string): { ready?: Promise<unknown>; current: () => boolean; release: () => void } {
    this.revoke(id)
    const predecessors = [...(this.captures.get(id) ?? [])]
    const token = {}
    const admissions = this.admissions.get(id) ?? new Set<object>()
    admissions.add(token)
    this.admissions.set(id, admissions)
    return {
      current: () => admissions.has(token),
      ready: predecessors.length
        ? Promise.all(predecessors.map((capture) => capture.persistenceReady))
        : undefined,
      release: () => {
        admissions.delete(token)
        if (!admissions.size && this.admissions.get(id) === admissions) {
          this.admissions.delete(id)
        }
      }
    }
  }
}
