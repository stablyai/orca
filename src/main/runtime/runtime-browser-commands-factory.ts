import { BrowserError } from '../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from './orca-runtime-browser'

/**
 * How `OrcaRuntimeService` obtains its browser-automation commands.
 *
 * Why a factory rather than a direct import: `orca-runtime-browser.ts` reaches the
 * whole Chromium cluster — `BrowserWindow`, `session`, `webContents`, cookie jars —
 * 15 modules that a Node host cannot load at all. Importing the class for its *type*
 * is free; constructing it is what drags the cluster in.
 *
 * The desktop installs the Electron factory. A Node host installs an external provider
 * when one resolves; otherwise every browser RPC rejects with the closed
 * `browser_unavailable` code and capability filtering hides the affordance.
 *
 * Deliberately NOT a stub object with silently-succeeding methods: that is the
 * "looks fine, returns a lie" shape this codebase rejects. Absent means rejected.
 */

export type RuntimeBrowserCommandsFactory = (
  host: RuntimeBrowserCommandHost
) => RuntimeBrowserCommands

export type RuntimeBrowserCommandsFactoryOptions = {
  /** The provider owns browser pages without a renderer window. */
  headless?: boolean
  /** Live health probe; failure must remove advertised capability. */
  isAvailable?: () => boolean
}

let currentFactory: RuntimeBrowserCommandsFactory | null = null
let currentOptions: RuntimeBrowserCommandsFactoryOptions = {}

export function setRuntimeBrowserCommandsFactory(
  factory: RuntimeBrowserCommandsFactory | null,
  options: RuntimeBrowserCommandsFactoryOptions = {}
): void {
  currentFactory = factory
  currentOptions = factory ? options : {}
}
export function runtimeBrowserCommandsFactoryIsAvailable(): boolean {
  if (!currentFactory) {
    return false
  }
  try {
    return currentOptions.isAvailable?.() !== false
  } catch {
    return false
  }
}

export function runtimeBrowserCommandsFactoryIsHeadless(): boolean {
  return runtimeBrowserCommandsFactoryIsAvailable() && currentOptions.headless === true
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
        throw new BrowserError(
          BROWSER_UNAVAILABLE_ERROR_CODE,
          'Browser automation is unavailable on this host.'
        )
      }
    }
  })
}
