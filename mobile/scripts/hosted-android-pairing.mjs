import {
  tapHostedAndroidAccessibilityControl,
  waitForHostedAndroidAccessibilityControlMatch
} from './hosted-android-emulator-accessibility.mjs'
import { openHostedAndroidUrl } from './hosted-android-emulator-session.mjs'

export async function pairHostedAndroidApp({ adb, pairingUrl, timeoutMs }) {
  const emulator = { adb }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await openHostedAndroidUrl(adb, pairingUrl)
    try {
      const control = await waitForHostedAndroidAccessibilityControlMatch(
        emulator,
        ['Close', 'Continue', 'Pair'],
        Math.min(5_000, deadline - Date.now())
      )
      if (control.label === 'Pair') {
        await tapHostedAndroidAccessibilityControl(emulator, control.label, 2_000)
        break
      }
      await tapHostedAndroidAccessibilityControl(emulator, control.label, 2_000)
    } catch {
      // The development bundle can mount after the first deep link.
    }
  }
  const destination = await waitForHostedAndroidAccessibilityControlMatch(
    emulator,
    [
      'Open sessions in Chat UI',
      'Open sessions in the terminal',
      'Enable agent notifications',
      'Skip notifications for now',
      'Show paired hosts',
      'Back to home'
    ],
    Math.max(1_000, deadline - Date.now())
  )
  if (destination.label === 'Back to home') {
    throw new Error('Android pairing failed before reaching the onboarding flow')
  }
}
