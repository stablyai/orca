// Integrator wiring (Unit 8, spec S6 pairing UX): mounts Unit 7's phone-side pairing page
// against the real HostProfileStore + parsePairingCode, and a throwaway-client probe-connect
// (construct an OrcaSocketClient, attempt the handshake, close it either way).
import type { GlassesBridge } from '../glasses/glasses-bridge'
import {
  createPhoneSettingsPage,
  type PairingOffer,
  type ProbeConnectResult
} from '../phone-page/phone-settings-page'
import { parsePairingCode } from '../transport/pairing-code-decode'
import { HostProfileStore } from '../transport/host-profile-store'
import { OrcaSocketClient } from '../transport/orca-socket-client'
import type { HostProfilePort } from './profile-controller'

const PROBE_TIMEOUT_MS = 8000

function probeConnect(offer: PairingOffer): Promise<ProbeConnectResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ProbeConnectResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      client.close()
      resolve(result)
    }
    const client = new OrcaSocketClient({
      endpoint: offer.endpoint,
      deviceToken: offer.deviceToken,
      serverPublicKeyB64: offer.publicKeyB64,
      onState: (state) => {
        if (state === 'connected') {
          finish({ ok: true })
        } else if (state === 'auth-failed') {
          finish({ ok: false, error: 'Authentication failed — check the pairing code' })
        }
      }
    })
    const timer = setTimeout(
      () => finish({ ok: false, error: 'Connection timed out' }),
      PROBE_TIMEOUT_MS
    )
  })
}

// `profiles` is the shared ProfileController from main.ts (finding #6) so pairing here also
// notifies the app shell; falls back to a standalone HostProfileStore when unwired (e.g. a
// caller that only needs the pairing form, or a test mounting this in isolation).
export function mountPhoneSettingsPage(bridge: GlassesBridge, profiles?: HostProfilePort): void {
  const root = document.getElementById('phone-settings-root')
  if (!root) {
    return
  }
  const store = profiles ?? new HostProfileStore(bridge)
  const page = createPhoneSettingsPage({ store, parsePairingCode, probeConnect })
  page.mount(root)
}
