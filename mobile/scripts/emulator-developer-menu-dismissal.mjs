import {
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlMatch
} from './hosted-ios-emulator-accessibility.mjs'

export async function dismissEmulatorDeveloperMenuIfPresent(
  emulator,
  tapControl = tapHostedIosAccessibilityControl
) {
  let dismissed = false
  try {
    await tapControl(emulator, 'Continue', 2_000)
    dismissed = true
  } catch {
    // The tutorial appears only on the first clean install.
  }
  try {
    await tapControl(emulator, 'Close', 2_000)
    dismissed = true
  } catch {
    // An ordinary launch has no developer overlay to close.
  }
  return dismissed
}

export async function dismissEmulatorDeveloperMenuBeforePairing(
  emulator,
  timeoutMs,
  waitForControl = waitForHostedIosAccessibilityControlMatch,
  tapControl = tapHostedIosAccessibilityControl
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = await waitForControl(
      emulator,
      ['Close', 'Continue', 'Open', 'Pair'],
      Math.max(1, deadline - Date.now())
    )
    if (match.label === 'Pair') {
      return
    }
    await tapControl(emulator, match.label, 2_000)
  }
  throw new Error('Pairing controls did not become accessible')
}
