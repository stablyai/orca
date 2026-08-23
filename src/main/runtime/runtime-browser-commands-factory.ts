import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from './orca-runtime-browser'

/**
 * How `OrcaRuntimeService` obtains its browser-automation commands.
 *
 * Why a factory rather than a direct import: `orca-runtime-browser.ts` reaches the
 * whole Chromium cluster — `BrowserWindow`, `session`, `webContents`, cookie jars —
 * 15 modules that a Node host cannot load at all. Importing the class for its *type*
 * is free; constructing it is what drags the cluster in.
 *
 * The desktop installs the real factory. A Node host installs none and every browser
 * RPC rejects with `browser_unavailable`, which the runtime already advertises through
 * capability filtering — clients do not offer the affordance.
 *
 * Deliberately NOT a stub object with silently-succeeding methods: that is the
 * "looks fine, returns a lie" shape this codebase rejects. Absent means rejected.
 */

export type RuntimeBrowserCommandsFactory = (
  host: RuntimeBrowserCommandHost
) => RuntimeBrowserCommands

let currentFactory: RuntimeBrowserCommandsFactory | null = null

export function setRuntimeBrowserCommandsFactory(
  factory: RuntimeBrowserCommandsFactory | null
): void {
  currentFactory = factory
}

/**
 * Build the commands, or a rejecting proxy when this host has no browser. The proxy
 * throws per call rather than at construction so the runtime still starts — the
 * capability is simply not advertised.
 */
export function createRuntimeBrowserCommands(
  host: RuntimeBrowserCommandHost
): RuntimeBrowserCommands {
  if (currentFactory) {
    return currentFactory(host)
  }
  return new Proxy({} as RuntimeBrowserCommands, {
    get: (_target, property) => {
      if (property === 'then') {
        // Why: an awaited undefined must not look like a thenable.
        return undefined
      }
      return () => {
        throw new Error(`browser_unavailable: ${String(property)} needs a desktop host`)
      }
    }
  })
}
