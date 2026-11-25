// Keeps the host from idle-sleeping while a bot's background run (Tidy-up, Look around) works.
// Only the desktop process can hold the system awake; it installs the hold at startup, and a host
// without one (orcad) runs without it.

export type BackgroundRunAwakeHold = () => () => void

let installed: BackgroundRunAwakeHold | null = null

export function installBackgroundRunAwakeHold(hold: BackgroundRunAwakeHold | null): void {
  installed = hold
}

/** Holds off idle system sleep until the returned release is called; a no-op without a hold. */
export function holdAwakeForBackgroundRun(): () => void {
  if (!installed) {
    return () => {}
  }
  try {
    return installed()
  } catch (error) {
    console.warn('[bots] could not hold the computer awake for a background run', error)
    return () => {}
  }
}
