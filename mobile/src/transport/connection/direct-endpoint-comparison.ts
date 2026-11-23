// Pairing may omit the trailing slash that URL normalization adds to advertised routes.
export function isSameDirectEndpoint(first: string, second: string): boolean {
  try {
    return new URL(first).href === new URL(second).href
  } catch {
    return first === second
  }
}
