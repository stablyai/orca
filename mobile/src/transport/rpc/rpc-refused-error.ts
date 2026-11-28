/** A request the host answered with a refusal: its code, its message, and the `data` a coded refusal
 *  (an agent-session refusal, for one) carries for the client to word. */
export class RpcRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    // No name of its own: screens that print `String(error)` keep reading "Error: <message>".
    super(message)
  }
}
