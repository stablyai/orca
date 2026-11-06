// One run owns the first observation failure even when the observed code catches it.
export class RecordingFault {
  private first: { origin: string; error: unknown } | undefined

  capture<T>(origin: string, read: () => T): T {
    try {
      return read()
    } catch (error) {
      this.report(origin, error)
      throw error
    }
  }

  report(origin: string, error: unknown): void {
    this.first ??= { origin, error }
  }

  check(): void {
    if (this.first) {
      throw this.first.error
    }
  }

  get failure(): { origin: string; error: unknown } | undefined {
    return this.first
  }
}
