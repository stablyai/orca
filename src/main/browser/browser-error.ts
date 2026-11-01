// Keep this error independent of Electron so Node hosts can load the runtime.
export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
