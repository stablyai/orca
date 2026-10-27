/** A snapshot that was only slow (timed out, or refused behind one still running), not broken. */
export class WindowsProcessTableTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WindowsProcessTableTimeoutError'
  }
}
