export class RecordingParamsMismatch extends Error {
  constructor(
    readonly request: string,
    readonly method: string,
    readonly frameId: string,
    readonly expected: unknown,
    readonly actual: unknown
  ) {
    super(`Request params mismatch: ${request}`)
  }
}

export class RecordingStreamGuard extends Error {
  constructor(
    readonly origin: 'scripted-frame-opening' | 'scripted-frame-params' | 'scripted-frame-routing',
    readonly request: string,
    message: string
  ) {
    super(message)
  }
}
