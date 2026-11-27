// Which agent sessions of a shared server subscribed to which of its resources. The child holds one
// subscription per resource for all of them: it's asked on the first subscribe, released on the last
// unsubscribe (or when that session ends), and its updates go only to the sessions that asked.
import {
  ErrorCode,
  McpError,
  type JSONRPCRequest,
  type Result
} from '@modelcontextprotocol/sdk/types.js'

/** The child answered with an error, so it kept what it held; a timeout or cancel may have reached it. */
const refused = (error: unknown): boolean =>
  error instanceof McpError &&
  error.code !== ErrorCode.RequestTimeout &&
  error.code !== ErrorCode.ConnectionClosed

export class SharedMcpResourceSubscriptions {
  /** `live` says whether a session is still open, so a refused release never revives an ended one. */
  constructor(private readonly live: (session: string) => boolean) {}

  private readonly byUri = new Map<string, Set<string>>()
  /** The child's answer to a resource's first subscribe, which later subscribers wait on. */
  private readonly pending = new Map<string, Promise<Result>>()
  /** A resource's last unsubscribe the child hasn't answered; a newer first subscribe supersedes it. */
  private readonly leaving = new Map<string, object>()

  /**
   * A subscribe or unsubscribe from `session`, sent to the child (`send`) only when it changes what
   * the child holds; null for any other request.
   */
  forward(
    request: Pick<JSONRPCRequest, 'method' | 'params'>,
    session: string,
    send: () => Promise<Result>
  ): Promise<Result> | null {
    const uri = request.params?.uri
    if (typeof uri !== 'string') {
      return null
    }
    if (request.method === 'resources/subscribe') {
      const holders = this.byUri.get(uri) ?? new Set<string>()
      const first = holders.size === 0
      holders.add(session)
      this.byUri.set(uri, holders)
      if (!first) {
        return this.pending.get(uri)?.then(() => ({})) ?? Promise.resolve({})
      }
      this.leaving.delete(uri)
      const sent = send()
      this.pending.set(uri, sent)
      return sent.then(
        (result) => {
          if (this.pending.get(uri) === sent) {
            this.pending.delete(uri)
          }
          return result
        },
        (error: unknown) => {
          // The child holds nothing, so neither does anyone who joined while it was asked.
          if (this.pending.get(uri) === sent) {
            this.pending.delete(uri)
          }
          if (this.byUri.get(uri) === holders) {
            this.byUri.delete(uri)
          }
          throw error
        }
      )
    }
    if (request.method === 'resources/unsubscribe') {
      return this.drop(uri, session) ? this.unsubscribe(uri, session, send) : Promise.resolve({})
    }
    return null
  }

  /** The sessions an update to `uri` goes to. */
  subscribers(uri: string): ReadonlySet<string> {
    return this.byUri.get(uri) ?? new Set()
  }

  /** `session` ended: the resources only it held, which the child no longer needs to watch. */
  release(session: string): string[] {
    return [...this.byUri.keys()].filter((uri) => this.drop(uri, session))
  }

  /** The last holder lets go; a refusal hands it back unless a newer subscribe came in meanwhile. */
  private unsubscribe(uri: string, session: string, send: () => Promise<Result>): Promise<Result> {
    const token = {}
    this.leaving.set(uri, token)
    // Its first subscribe may still be answered: the child holds nothing if that fails.
    const subscribed = this.pending.get(uri)?.then(
      () => true,
      () => false
    )
    const current = (): boolean => {
      const ours = this.leaving.get(uri) === token
      if (ours) {
        this.leaving.delete(uri)
      }
      return ours
    }
    return send().then(
      (result) => {
        current()
        return result
      },
      async (error: unknown) => {
        // The child still watches it, so the session holds it again: a retry or its end asks again.
        const held = (await subscribed) ?? true
        if (current() && held && refused(error) && this.live(session)) {
          this.byUri.set(uri, new Set([session]))
        }
        throw error
      }
    )
  }

  /** True when `session` was the last holder of `uri`. */
  private drop(uri: string, session: string): boolean {
    const holders = this.byUri.get(uri)
    if (!holders?.delete(session)) {
      return false
    }
    if (holders.size > 0) {
      return false
    }
    this.byUri.delete(uri)
    return true
  }
}
