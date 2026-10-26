// Keep every layer above the overlay drawer transparent so its own scrim can dim the underlying screen.
export function isOverlayPageRoute(pathname: string): boolean {
  return /^\/h\/[^/]+\/new-workspace$/.test(pathname)
}
