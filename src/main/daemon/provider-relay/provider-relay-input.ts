export const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** An agent that stops reading must not grow the daemon's buffer without bound; the client retries. */
const MAX_QUEUED_INPUT_BYTES = 16 * 1024 * 1024

type RelayStdin = {
  readonly writableLength: number
  write(data: string, callback?: (error?: Error | null) => void): unknown
}

/** A relay's stdin: bounded, and a surrogate pair split between two writes encodes whole. */
export class ProviderRelayInput {
  private carry = ''
  /** Whether the agent's stdin ends at a line boundary, so a line of the daemon's own starts clean. */
  private lineEnded = true

  constructor(private readonly stdin: RelayStdin) {}

  /** The text to write now for this chunk; a trailing high surrogate waits for the next one. */
  take(chunk: string): string {
    const joined = this.carry + chunk
    const split = isHighSurrogate(joined.charCodeAt(joined.length - 1))
    const data = split ? joined.slice(0, -1) : joined
    if (this.stdin.writableLength + Buffer.byteLength(data) > MAX_QUEUED_INPUT_BYTES) {
      throw new Error('Relay input is full')
    }
    this.carry = split ? joined.slice(-1) : ''
    return data
  }

  write(data: string, callback: (error?: Error | null) => void): void {
    this.lineEnded = data.length > 0 ? data.endsWith('\n') : this.lineEnded
    this.stdin.write(data, callback)
  }

  /** A line the daemon writes itself (no app is attached to answer it); an app's cut-off line ends first. */
  writeLine(line: string): true {
    this.stdin.write(this.lineEnded ? line : `\n${line}`, () => {})
    this.lineEnded = true
    return true
  }

  /** A lone half left by the last write still reaches the agent, as it did before pairs were joined. */
  flush(): void {
    if (this.carry) {
      this.stdin.write(this.carry)
      this.carry = ''
    }
  }
}
