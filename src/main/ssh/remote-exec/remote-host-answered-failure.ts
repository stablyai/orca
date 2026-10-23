/** A host-side step that answered with something other than success, carrying what it said. */
export class RelayHostAnsweredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayHostAnsweredError'
  }
}
