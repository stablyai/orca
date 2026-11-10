// Main's runtime-environment pairing tells Orca Cloud when a pairing code was verified end to end
// (E2EE handshake with the workspace's orcad), so a grant's read-snapshot signer may re-pin only
// then. A seam with no imports, so the runtime-environment handlers never load the cloud service.
let listener: ((pairingCode: string) => Promise<void>) | null = null

export function setCloudPairingVerifiedListener(next: typeof listener): void {
  listener = next
}

/** Never throws: a failed re-pin must not fail the pairing itself. */
export async function noteRuntimePairingVerified(pairingCode: string): Promise<void> {
  try {
    await listener?.(pairingCode)
  } catch (error) {
    console.error(`[orca-cloud] read signer re-pin after pairing failed: ${String(error)}`)
  }
}
