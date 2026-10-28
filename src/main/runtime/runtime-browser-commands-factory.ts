import { BrowserError } from '../browser/browser-error'
import {
  BROWSER_UNAVAILABLE_ERROR_CODE,
  type RuntimeBrowserUnavailableReason
} from '../../shared/runtime-types'
import type { RuntimeBrowserCommandHost } from './browser/browser-command-contracts'
import type { RuntimeBrowserCommands } from './browser/browser-commands'
import { closeBrowserPageWithoutEngine } from './browser/browser-client-page-close'

/** Inject Electron browser construction to keep Chromium imports out of Node hosts; type imports remain safe.
 * Node hosts use external providers or reject browser_unavailable and hide capability; never silently succeed with a stub. */

export type RuntimeBrowserCommandsFactory = (
  host: RuntimeBrowserCommandHost
) => RuntimeBrowserCommands

export type RuntimeBrowserCommandsFactoryOptions = {
  /** The provider creates pages against this runtime's client-host lease registry. */
  clientHosting?: boolean
  /** Client pages live in this runtime's own registries, so they need no healthy engine. */
  clientHostingWithoutEngine?: boolean
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

export function runtimeBrowserCommandsFactorySupportsClientHosting(): boolean {
  if (currentFactory && currentOptions.clientHostingWithoutEngine === true) {
    return true
  }
  return runtimeBrowserCommandsFactoryIsAvailable() && currentOptions.clientHosting === true
}

export type RuntimeBrowserUnavailableCause = {
  reason: RuntimeBrowserUnavailableReason
  detail?: string
}

let unavailableCause: RuntimeBrowserUnavailableCause | null = null

/** Only provider resolution can distinguish missing driver/config/launch failure; clear the note once a provider resolves. */
export function setRuntimeBrowserUnavailableCause(
  cause: RuntimeBrowserUnavailableCause | null
): void {
  unavailableCause = cause
}

/** Healthy factory wins; otherwise retain resolver evidence, or report engine death if none. Infer no unproven cause. */
export function runtimeBrowserUnavailableCause(): RuntimeBrowserUnavailableCause {
  if (currentFactory && runtimeBrowserCommandsFactoryIsAvailable()) {
    return { reason: 'desktop_window_unavailable' }
  }
  return unavailableCause ?? { reason: currentFactory ? 'provider_unhealthy' : 'unknown' }
}

/** Reject per call when unavailable so runtime startup still succeeds and capability is hidden. */
export function createRuntimeBrowserCommands(
  host: RuntimeBrowserCommandHost
): RuntimeBrowserCommands {
  if (currentFactory) {
    return currentFactory(host)
  }
  return new Proxy({} as RuntimeBrowserCommands, {
    get: (_target, property) => {
      if (property === 'then') {
        // Avoid treating the proxy as a thenable when awaited.
        return undefined
      }
      if (property === 'browserTabClose') {
        // Stale client-hosted tabs remain closeable even without an engine.
        return (params: Parameters<RuntimeBrowserCommands['browserTabClose']>[0]) =>
          closeBrowserPageWithoutEngine(host, params ?? {}, browserUnavailableError)
      }
      return () => {
        throw browserUnavailableError()
      }
    }
  })
}

export function browserUnavailableError(): BrowserError {
  return new BrowserError(
    BROWSER_UNAVAILABLE_ERROR_CODE,
    'Browser automation is unavailable on this host.'
  )
}
