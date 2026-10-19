const MAX_FINAL_TAIL_BYTES = 16 * 1024 * 1024
const MAX_FINAL_TAIL_OPERATIONS = 512

/** Finalized providers can admit their bounded tail before the host takes its exit barrier. */
export class StructuredAgentSessionFinalTailReservation {
  private bytes = 0
  private operations = 0
  private closed = false

  reserve(bytes: number): (() => void) | null {
    if (
      this.closed ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > MAX_FINAL_TAIL_BYTES ||
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
