// agy reports the same OSC 7501 blocked:auth while it silently signs in behind a
// "Signing in..." spinner as at its login menu (#44603), and a keyring or ADC sign-in
// over a slow network can spin well past the persistence window. Only the screens a
// signed-out agy rests on prove a human must sign in.
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
