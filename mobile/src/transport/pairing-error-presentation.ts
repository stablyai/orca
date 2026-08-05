const RETIRED_PUBLICATION_ERROR = 'host profile publication was retired'

export function pairingErrorMessage(
  error: unknown,
  timedOut: boolean,
  timeoutSeconds: number
): string {
  if (timedOut) {
    return `Couldn't reach your desktop within ${timeoutSeconds} seconds. Make sure Orca is open on the desktop and both devices are online, then try scanning again.`
  }
  const detail = error instanceof Error ? error.message : String(error)
  if (detail === RETIRED_PUBLICATION_ERROR) {
    return "Pairing needs to be restarted. The desktop's pairing information changed before setup finished. Open Mobile settings on the desktop and scan the latest QR code."
  }
  return 'Pairing could not be completed. Make sure Orca is open on the desktop and both devices are online, then try again.'
}
