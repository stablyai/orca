export class RelayOuterError extends Error {
  constructor(readonly code: number) {
    super(`relay_outer_${code}`)
  }
}
