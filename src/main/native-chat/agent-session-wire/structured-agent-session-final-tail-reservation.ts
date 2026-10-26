const MAX_FINAL_TAIL_OPERATIONS = 512

/** A sealed lane transfers already-observed work before the host takes its exit barrier. */
export class StructuredAgentSessionFinalTailReservation {
  private bytes = 0
  private operations = 0
  private closed = false

  reserve(bytes: number): (() => void) | null {
    if (
      this.closed ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.operations >= MAX_FINAL_TAIL_OPERATIONS
    ) {
      return null
    }
    this.bytes += bytes
    this.operations += 1
    let released = false
    return () => {
      if (released || this.closed) {
        return
      }
      released = true
      this.bytes -= bytes
      this.operations -= 1
    }
  }

  close(): void {
    this.closed = true
    this.bytes = 0
    this.operations = 0
  }
}
