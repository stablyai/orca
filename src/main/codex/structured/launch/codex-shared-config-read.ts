import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'

type ConfigReadConnection = Pick<CodexAppServerConnection, 'request'>

/** The longest deadline a launch's config readers ask for; the shared read runs at least this long. */
const SHARED_CONFIG_READ_MS = 10_000

function within<T>(read: Promise<T>, timeoutMs: number | null | undefined): Promise<T> {
  if (timeoutMs === null || timeoutMs === undefined) {
    return read
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`codex app-server config/read timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    read.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * `connection` with one `config/read` per set of params for the steps of one launch, which run
 * together: each step still gets its own deadline and handles its own failure. Other requests pass
 * through. Keep it for one launch only; a later launch reads Codex's config again.
 */
export function sharingCodexConfigReads(connection: ConfigReadConnection): ConfigReadConnection {
  const reads = new Map<string, Promise<unknown>>()
  return {
    request: (method, params, options) => {
      if (method !== 'config/read' || options?.onReply) {
        return connection.request(method, params, options)
      }
      const key = JSON.stringify(params ?? {})
      let read = reads.get(key)
      if (!read) {
        const asked = options?.timeoutMs
        read = connection.request(method, params, {
          timeoutMs:
            asked === null || asked === undefined ? asked : Math.max(asked, SHARED_CONFIG_READ_MS)
        })
        reads.set(key, read)
      }
      return within(read, options?.timeoutMs)
    }
  }
}
