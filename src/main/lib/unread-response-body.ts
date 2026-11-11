/** Cancel unused bodies to avoid Node/undici process crashes (nodejs/undici#5360, orca#8695). */
export async function cancelUnreadResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cancelling an already-errored, locked, or closed stream is harmless.
  }
}
