export type OmpAuxiliaryDerivationErrorCode =
  | 'invalid-source'
  | 'unsupported-version'
  | 'session-mismatch'
  | 'unstable-boundary'
  | 'write-failed'

export class OmpAuxiliaryDerivationError extends Error {
  readonly code: OmpAuxiliaryDerivationErrorCode

  constructor(code: OmpAuxiliaryDerivationErrorCode, message: string) {
    super(message)
    this.name = 'OmpAuxiliaryDerivationError'
    this.code = code
  }
}
