// Unit 8: app shell bootstrap (spec S10) — bridge detect -> host profile load -> first render
// -> connect, plus mounting the phone-side pairing page (spec S6).
import { detectGlassesBridge } from './app/bridge-detection'
import { startAppShell } from './app/app-shell'
import { mountPhoneSettingsPage } from './app/phone-page-mount'

async function main(): Promise<void> {
  const bridge = await detectGlassesBridge()
  mountPhoneSettingsPage(bridge)
  await startAppShell({ bridge })
}

void main()
