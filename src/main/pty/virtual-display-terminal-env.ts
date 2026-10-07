/** Names the DISPLAY value headless serve adopted for its own Xvfb, so terminals can drop it. */
export const ORCA_VIRTUAL_DISPLAY_ENV = 'ORCA_VIRTUAL_DISPLAY'

export function removeOrcaVirtualDisplayEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  const virtualDisplay = env[ORCA_VIRTUAL_DISPLAY_ENV]
  delete env[ORCA_VIRTUAL_DISPLAY_ENV]
  if (!virtualDisplay || env.DISPLAY !== virtualDisplay || explicitEnv?.DISPLAY !== undefined) {
    return
  }
  // Why: nobody can see Orca's Xvfb, so clipboard-aware CLIs (Pi, xclip, xsel) would copy
  // into it instead of falling back to OSC 52, which reaches the viewing client's clipboard.
  delete env.DISPLAY
}
