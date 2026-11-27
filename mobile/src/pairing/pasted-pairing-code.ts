// Held in memory, never in the route: an orca://pair-scan?code= link must not pair without the confirm screen.
let pasted: string | null = null

/** Feed's Paste code hands its code to the scan screen it is about to open. */
export function handOffPastedPairingCode(code: string): void {
  pasted = code
}

/** The scan screen takes the code once; a later visit opens the camera. */
export function takePastedPairingCode(): string | null {
  const code = pasted
  pasted = null
  return code
}
