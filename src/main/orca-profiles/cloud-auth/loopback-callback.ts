import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS } from './profile-cloud-callback-page'

/** What one request to the callback path means for the flow waiting on it. */
export type LoopbackCallbackHit<T> =
  | { kind: 'accept'; value: T }
  /** Ends the flow, e.g. the provider reported a denial. */
  | { kind: 'reject'; error: Error; message: string }
  /** Not ours (a probe, a stale tab): answered, and the flow keeps waiting. */
  | { kind: 'stray'; message: string }

export type LoopbackCallbackErrors = {
  timeout: string
  cancelled: string
  unavailable: string
  failed: string
}

/**
 * A page that can't be shown whole at once: `received` goes out as soon as a hit is accepted, and
 * `finish` answers the rest once the work it waits on is done. The flow resolves after that.
 */
export type LoopbackCallbackPages<T> = {
  received: string
  /** Never rejects: a failure is a page of its own. */
  finish: (value: T) => Promise<string>
}

// Longer than any authorization response; a bigger request is not a browser return.
const MAX_REQUEST_URL = 8192
const MAX_HEADER_BYTES = 16 * 1024
// A browser sends its return at once; a connection that dribbles it in is not one.
const READ_DEADLINE_MS = 10_000
const TEXT_HEADERS = {
  ...ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS,
  'content-type': 'text/plain; charset=utf-8'
}

function closeServer(server: Server): void {
  try {
    // Browser keep-alive sockets can delay close and timeout cleanup.
    server.closeAllConnections?.()
    server.close()
  } catch {
    // Already closed.
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening)
      reject(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      resolve()
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(port, '127.0.0.1')
  })
}

type LoopbackCallbackOptions<T> = {
  path: string
  timeoutMs: number
  errors: LoopbackCallbackErrors
  read: (url: URL) => LoopbackCallbackHit<T>
  onListening: (port: number) => Promise<void> | void
  signal?: AbortSignal
  /** How long a connection may take to send its whole request; 10 s unless set. */
  readDeadlineMs?: number
}

/** How a held return's tab reads: `received` at once, `pending` if no outcome comes in `ms`. */
export type LoopbackCallbackHold = {
  received: string
  /** An outcome part (orcaCallbackOutcome), also shown when `signal` aborts after the return. */
  pending: string
  ms: number
}

export type HeldLoopbackReturn<T> = {
  value: T
  /** Ends the tab's page with an outcome part; only the first answer counts. */
  answer: (outcome: string) => void
}

/**
 * Like serveLoopbackCallback with a two-part page, but resolves with the accepted value at once,
 * for a caller that needs the value to reach its outcome (a paired host finishing the sign-in).
 * The tab shows `received` until `answer`, the hold timeout, or `signal`.
 */
export function serveHeldLoopbackCallback<T>(
  options: LoopbackCallbackOptions<T> & { hold: LoopbackCallbackHold }
): Promise<HeldLoopbackReturn<T>> {
  const { hold, signal } = options
  return new Promise((resolve, reject) => {
    const outcome = Promise.withResolvers<string>()
    const pending = (): void => outcome.resolve(hold.pending)
    serveLoopbackCallback<T>({
      ...options,
      successPage: {
        received: hold.received,
        finish: (value) => {
          const timer = setTimeout(pending, hold.ms)
          signal?.addEventListener('abort', pending, { once: true })
          resolve({ value, answer: outcome.resolve })
          return outcome.promise.finally(() => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', pending)
          })
        }
      }
    }).catch(reject)
  })
}

/**
 * Serves one browser return on 127.0.0.1 at a random port: resolves with the first accepted hit,
 * rejects on a rejected hit, the timeout or `signal`, and always closes the listener. Only a GET to
 * `path` on this listener's own host counts. `onListening` gets the port; if it throws, the flow
 * fails with its error.
 */
export function serveLoopbackCallback<T>(
  options: LoopbackCallbackOptions<T> & { successPage: string | LoopbackCallbackPages<T> }
): Promise<T> {
  const { errors, successPage } = options
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(errors.cancelled))
      return
    }
    let settled = false
    // Once a hit is accepted its page is still being written: no timeout or cancel cuts it off.
    let accepted = false
    let hosts: ReadonlySet<string> = new Set()

    function rejectFlow(error: Error): void {
      if (settled || accepted) {
        return
      }
      settled = true
      reject(error)
      closeServer(server)
    }

    function resolveFlow(value: T): void {
      settled = true
      resolve(value)
      closeServer(server)
    }

    function answer(
      response: ServerResponse,
      status: number,
      body: string,
      headers: Record<string, string> = {}
    ): void {
      response.writeHead(status, { ...TEXT_HEADERS, ...headers })
      response.end(body)
    }

    async function finishPage(response: ServerResponse, value: T): Promise<void> {
      response.writeHead(200, ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS)
      if (typeof successPage === 'string') {
        response.end(successPage)
        resolveFlow(value)
        return
      }
      response.write(successPage.received)
      const rest = await successPage.finish(value)
      response.end(rest, () => resolveFlow(value))
    }

    // Enforced per connection: Node's own request timeouts are only checked every 30 s.
    const readDeadlines = new WeakMap<Socket, ReturnType<typeof setTimeout>>()
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      // A GET is fully read once it is here; the response may then be held as long as it needs.
      clearTimeout(readDeadlines.get(request.socket))
      try {
        if (request.method !== 'GET') {
          answer(response, 405, 'Method not allowed', { allow: 'GET' })
          return
        }
        // Another name for this listener (DNS rebinding) is not the browser's return.
        if (!hosts.has(request.headers.host ?? '')) {
          answer(response, 421, 'Not found')
          return
        }
        if ((request.url ?? '').length > MAX_REQUEST_URL) {
          answer(response, 414, 'Request too long')
          return
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== options.path) {
          answer(response, 404, 'Not found')
          return
        }
        if (settled || accepted) {
          answer(response, 410, 'This sign-in already came back. Return to Orca.')
          return
        }
        const hit = options.read(url)
        if (hit.kind === 'stray') {
          answer(response, 400, hit.message)
          return
        }
        if (hit.kind === 'reject') {
          answer(response, 400, hit.message)
          rejectFlow(hit.error)
          return
        }
        accepted = true
        clearTimeout(timeout)
        finishPage(response, hit.value).catch(() => {
          response.destroy()
          resolveFlow(hit.value)
        })
      } catch (error) {
        rejectFlow(error instanceof Error ? error : new Error(errors.failed))
      }
    })

    server.on('connection', (socket) => {
      const deadline = setTimeout(
        () => socket.destroy(),
        options.readDeadlineMs ?? READ_DEADLINE_MS
      )
      readDeadlines.set(socket, deadline)
      socket.once('close', () => clearTimeout(deadline))
    })
    const timeout = setTimeout(() => rejectFlow(new Error(errors.timeout)), options.timeoutMs)
    const cancel = (): void => rejectFlow(new Error(errors.cancelled))
    options.signal?.addEventListener('abort', cancel, { once: true })
    server.once('close', () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', cancel)
    })
    listen(server, 0).then(
      () => {
        server.on('error', rejectFlow)
        const address = server.address()
        if (!address || typeof address === 'string') {
          rejectFlow(new Error(errors.unavailable))
          return
        }
        hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
        Promise.resolve()
          .then(() => options.onListening(address.port))
          .catch((error: unknown) =>
            rejectFlow(error instanceof Error ? error : new Error(errors.failed))
          )
      },
      (error: Error) => rejectFlow(error)
    )
  })
}
