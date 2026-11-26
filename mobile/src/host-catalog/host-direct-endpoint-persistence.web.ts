// Saved direct endpoints belong to the native endpoint lifecycle, which the page does not run.
export function recordHostDirectEndpoints(
  _hostId: string,
  _endpoints: readonly string[]
): Promise<string | null> {
  return Promise.resolve(null)
}
