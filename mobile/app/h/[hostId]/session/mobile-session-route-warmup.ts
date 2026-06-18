let mobileSessionScreenWarmup: Promise<unknown> | null = null

export function warmMobileSessionScreen(): Promise<unknown> {
  if (!mobileSessionScreenWarmup) {
    mobileSessionScreenWarmup = import('./mobile-session-screen').catch((error: unknown) => {
      mobileSessionScreenWarmup = null
      throw error
    })
  }
  return mobileSessionScreenWarmup
}
