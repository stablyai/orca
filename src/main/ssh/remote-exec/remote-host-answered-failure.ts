/** Positive host failure evidence, distinct from unanswered transport operations. */
export class RelayHostAnsweredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayHostAnsweredError'
  }
}
