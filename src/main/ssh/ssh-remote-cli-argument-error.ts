export type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export class RemoteCliArgumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteCliArgumentError'
    this.code = code
  }
}
