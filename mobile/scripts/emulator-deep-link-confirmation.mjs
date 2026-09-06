import {
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlMatch
} from './hosted-ios-emulator-accessibility.mjs'

export async function confirmEmulatorPairingDeepLink(
  emulator,
  timeoutMs,
  waitForControl = waitForHostedIosAccessibilityControlMatch,
  tapControl = tapHostedIosAccessibilityControl
) {
  const nextControl = await waitForControl(emulator, ['Open', 'Pair'], timeoutMs)
  if (nextControl.label === 'Open') {
    await tapControl(emulator, 'Open', timeoutMs)
  }
  await tapControl(emulator, 'Pair', timeoutMs)
}
