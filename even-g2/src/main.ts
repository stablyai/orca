// Unit 8: app shell bootstrap (spec S10) — bridge detect -> host profile load -> first render
// -> connect, plus mounting the phone-side pairing page (spec S6).
import { detectGlassesBridge } from './app/bridge-detection'
import { startAppShell } from './app/app-shell'
import { mountPhoneSettingsPage } from './app/phone-page-mount'
import { ProfileController } from './app/profile-controller'
import { HostProfileStore } from './transport/host-profile-store'

async function main(): Promise<void> {
  const bridge = await detectGlassesBridge()
  // Shared across the phone pairing page and the shell (finding #6) so pairing/removing a host
  // after startup updates the running shell instead of only the phone page's own DOM.
  const profiles = new ProfileController(new HostProfileStore(bridge))
  mountPhoneSettingsPage(bridge, profiles)
  await startAppShell({ bridge, profiles })
}

// detectGlassesBridge() only rejects on real hardware with no bridge at all and no simulator
// opt-in (finding #7) — it already leaves a recoverable notice in the DOM, so this just avoids
// an unhandled rejection.
main().catch((error: unknown) => {
  console.error('[orca-g2] failed to start:', error)
})
