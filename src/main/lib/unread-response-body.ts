/**
 * Cancel a fetch Response body that no code path will read. Why: leaving it
 * unread can crash the whole process from inside Node's bundled undici
 * (nodejs/undici#5360, orca#8695); see global-fetch-call-site-audit.test.ts.
 */
export async function cancelUnreadResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cancelling an already-errored, locked, or closed stream is harmless.
  }
}
