import {
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix
} from './hosted-ios-emulator-accessibility.mjs'

const ONBOARDING_SETTLE_TIMEOUT_MS = 5_000
const EXISTING_STATE_TIMEOUT_MS = 1_000

export async function completeHostedIosNativeOnboarding(emulator, workspaceName, timeoutMs) {
  try {
    await waitForHostedIosAccessibilityControlByLabelPrefix(
      emulator,
      workspaceName,
      Math.min(timeoutMs, EXISTING_STATE_TIMEOUT_MS)
    )
    return {
      sessionView: 'retained',
      notifications: 'retained'
    }
  } catch {}
  await tapHostedIosAccessibilityControl(emulator, 'Open sessions in the terminal', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Skip notifications for now', timeoutMs)
  try {
    await waitForHostedIosAccessibilityControlByLabelPrefix(
      emulator,
      workspaceName,
      Math.min(timeoutMs, ONBOARDING_SETTLE_TIMEOUT_MS)
    )
  } catch {
    await tapHostedIosAccessibilityControl(
      emulator,
      'Back to worktrees',
      Math.min(timeoutMs, ONBOARDING_SETTLE_TIMEOUT_MS)
    )
    await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, workspaceName, timeoutMs)
  }
  return {
    sessionView: 'terminal',
    notifications: 'skipped'
  }
}
