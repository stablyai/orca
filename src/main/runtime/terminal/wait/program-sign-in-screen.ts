// agy's "Signing in..." spinner reports the same blocked:auth as its login menu (#44603); only the menu needs a human.
const SIGN_IN_WAIT_SCREEN_MARKERS = [
  // agy 1.5.x with no saved credential.
  'select login method',
  // agy 1.5.x with AGY_ADC_AUTH set and no usable Application Default Credentials.
  'no authentication methods available'
] as const

const SIGNING_IN_MARKER = 'signing in...'

/** Whether the tail ends at a screen that waits for a human to sign in, not at a sign-in still in progress. */
export function isProgramSignInWaitScreen(tail: string): boolean {
  const normalized = tail.toLowerCase()
  const signingInAt = normalized.lastIndexOf(SIGNING_IN_MARKER)
  return SIGN_IN_WAIT_SCREEN_MARKERS.some((marker) => normalized.lastIndexOf(marker) > signingInAt)
}
