/** The daemon's refusal of input past its queue cap. */
export const RELAY_INPUT_FULL = 'Relay input is full'

const FIRST_RETRY_MS = 50
const MAX_RETRY_MS = 2_000

/** Refused input is offered again after a wait that doubles, up to 2 s, while the agent isn't reading. */
export class RelayInputBackoff {
  private nextMs = FIRST_RETRY_MS

  wait(): Promise<void> {
    const ms = this.nextMs
    this.nextMs = Math.min(ms * 2, MAX_RETRY_MS)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
