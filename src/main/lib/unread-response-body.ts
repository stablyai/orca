/**
 * Cancel a fetch Response body that no code path will read.
 *
 * Why: Node's bundled undici (used by global fetch, unlike Electron's
 * net.fetch) crashes the whole process with an uncatchable AssertionError
 * when a response body large enough to pause the HTTP/1 parser is left
 * unread and the peer closes the socket (nodejs/undici#5360, orca#8695).
 * Every main-process global-fetch call site must consume or cancel the
 * body on all paths, including !response.ok early returns.
 */
export async function cancelUnreadResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cancelling an already-errored, locked, or closed stream is harmless.
  }
}
