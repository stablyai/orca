/**
 * The error every browser command rejects with.
 *
 * Why its own module: this is seven lines with no dependencies, but it lived in
 * `cdp-bridge.ts`, which imports `webContents` and drags the whole Chromium cluster
 * along. The runtime catches this type on paths that have nothing to do with CDP, so
 * that one import kept a Node host from loading the runtime at all.
 */
export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
