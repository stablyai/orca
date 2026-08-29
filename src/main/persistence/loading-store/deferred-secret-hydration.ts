import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import { PROTECTED_SECRET_SLOT } from '../../protected-secret-persistence'
import {
  decodeBrowserKagiSessionLink,
  decodeHttpProxyUrl,
  decodeOpencodeSessionCookie,
  decodeSshPtyOwnerLease
} from './protected-secret-decoding'
import type { StoreRuntimeState } from './store-runtime-state'

type DeferredSecretHydrationRuntime = Pick<StoreRuntimeState, 'protectedSecrets' | 'state'>

export type DeferredSecretHydrationResult = {
  /** False when the load already probed the keyring, so there is nothing left to finish. */
  hydrated: boolean
  settingsUpdates: Partial<GlobalSettings>
  uiChanged: boolean
  /** True when a slot was dropped as unusable, which only reaches disk on the next save. */
  needsSave: boolean
}

const NOTHING_DEFERRED: DeferredSecretHydrationResult = {
  hydrated: false,
  settingsUpdates: {},
  uiChanged: false,
  needsSave: false
}

/**
 * Finish the protected slots a deferred load left sealed, now that blocking the main thread
 * no longer blocks a window from appearing.
 *
 * Why re-read from the retained ciphertext rather than from state: a deferred load exposes
 * nothing, exactly as it does when the keyring is genuinely unavailable, so state holds the
 * withheld value and the ciphertext lives only in the retention map.
 */
export function hydrateDeferredProtectedSecrets(
  runtime: DeferredSecretHydrationRuntime
): DeferredSecretHydrationResult {
  const secrets = runtime.protectedSecrets
  if (!secrets.isKeyringProbeDeferred()) {
    return NOTHING_DEFERRED
  }
  secrets.resumeKeyringProbe()

  const settingsUpdates: Partial<GlobalSettings> = {}
  let needsSave = false
  let uiChanged = false

  // Why each slot is claimed only while still withheld: the deferred load left it at '', so a
  // non-empty value now is a write that landed after the window came up and before hydration ran.
  // Overwriting it from the retained ciphertext would silently revert the user's own change.
  const cookieBlob = secrets.retainedBlob(PROTECTED_SECRET_SLOT.opencodeSessionCookie)
  if (cookieBlob && !runtime.state.settings.opencodeSessionCookie) {
    const cookie = decodeOpencodeSessionCookie(secrets, cookieBlob)
    if (cookie !== runtime.state.settings.opencodeSessionCookie) {
      runtime.state.settings.opencodeSessionCookie = cookie
      settingsUpdates.opencodeSessionCookie = cookie
    }
  }

  const proxyBlob = secrets.retainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
  if (proxyBlob && !(runtime.state.settings.httpProxyUrl ?? '')) {
    const proxy = decodeHttpProxyUrl(secrets, proxyBlob)
    needsSave ||= proxy.cleared
    if (proxy.value !== (runtime.state.settings.httpProxyUrl ?? '')) {
      runtime.state.settings.httpProxyUrl = proxy.value
      settingsUpdates.httpProxyUrl = proxy.value
    }
  }

  const kagiBlob = secrets.retainedBlob(PROTECTED_SECRET_SLOT.browserKagiSessionLink)
  if (kagiBlob && !(runtime.state.ui.browserKagiSessionLink ?? '')) {
    const link = decodeBrowserKagiSessionLink(secrets, kagiBlob)
    if (link !== (runtime.state.ui.browserKagiSessionLink ?? '')) {
      runtime.state.ui.browserKagiSessionLink = link
      uiChanged = true
    }
  }

  const recoveries = runtime.state.sshPtyConsumerRecoveries
  if (recoveries && recoveries.length > 0) {
    const decoded = recoveries
      .map((record) => decodeSshPtyOwnerLease(secrets, record))
      .filter((record): record is SshPtyConsumerRecovery => record !== null)
    needsSave ||= decoded.length !== recoveries.length
    runtime.state.sshPtyConsumerRecoveries = decoded
  }

  return { hydrated: true, settingsUpdates, uiChanged, needsSave }
}
