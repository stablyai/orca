import {
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY,
  BROWSER_MOBILE_STOP_RUNTIME_CAPABILITY,
  BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY
} from '../../../src/shared/browser/runtime/browser-runtime-capabilities'

/** Browser controls the paired host can serve; older hosts lack some, so the phone hides them. */
export type MobileBrowserHostSupport = {
  certificateTrust: boolean
  /** Older hosts refuse browser.stop from a phone, so Reload never turns into Stop there. */
  stop: boolean
  /** Older hosts drop reload's ignoreCache and reload normally, so Hard reload stays hidden. */
  hardReload: boolean
}

export const NO_MOBILE_BROWSER_HOST_SUPPORT: MobileBrowserHostSupport = {
  certificateTrust: false,
  stop: false,
  hardReload: false
}

export function mobileBrowserHostSupport(
  capabilities: readonly string[]
): MobileBrowserHostSupport {
  return {
    certificateTrust: capabilities.includes(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY),
    stop: capabilities.includes(BROWSER_MOBILE_STOP_RUNTIME_CAPABILITY),
    hardReload: capabilities.includes(BROWSER_STOP_HARD_RELOAD_RUNTIME_CAPABILITY)
  }
}
