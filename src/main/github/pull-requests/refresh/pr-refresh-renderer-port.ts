/** The desktop renderers PR refresh serves. A Node host (orcad) has none: no window reports
 *  visible PRs there, and refresh events go nowhere. Electron installs its own at startup. */
export type PRRefreshRendererPort = {
  /** Whether the renderer that reported visible PRs is still open. */
  isRendererOpen(webContentsId: number): boolean
  sendToTrustedUI(channel: string, payload: unknown): void
}

const headless: PRRefreshRendererPort = {
  isRendererOpen: () => false,
  sendToTrustedUI: () => {}
}

let current = headless

export function setPRRefreshRendererPort(port: PRRefreshRendererPort | null): void {
  current = port ?? headless
}

export function prRefreshRenderers(): PRRefreshRendererPort {
  return current
}
