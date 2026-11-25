// Which agent sessions of a shared server subscribed to which of its resources. The child holds one
// subscription per resource for all of them: it's asked on the first subscribe, released on the last
// unsubscribe (or when that session ends), and its updates go only to the sessions that asked.
import type { JSONRPCRequest, Result } from '@modelcontextprotocol/sdk/types.js'

export class SharedMcpResourceSubscriptions {
  private readonly byUri = new Map<string, Set<string>>()

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
        return Promise.resolve({})
      }
      return send().catch((error: unknown) => {
        this.drop(uri, session)
        throw error
      })
    }
    if (request.method === 'resources/unsubscribe') {
      return this.drop(uri, session) ? send() : Promise.resolve({})
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
