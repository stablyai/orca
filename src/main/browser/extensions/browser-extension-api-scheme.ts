import { BROWSER_EXTENSION_API_SCHEME } from '../../../shared/browser-extension-worker-api'

/** Registered at preflight with the other privileged schemes; Electron freezes the table at ready. */
export const BROWSER_EXTENSION_API_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: BROWSER_EXTENSION_API_SCHEME,
  // Why allowServiceWorkers: without it Electron 43 never routes a worker's fetch to the handler.
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    allowServiceWorkers: true
  }
}
