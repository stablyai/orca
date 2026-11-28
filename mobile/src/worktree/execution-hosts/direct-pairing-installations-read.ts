const NONE: ReadonlySet<string> = new Set()

/** Only a page hides relayed copies (the shell answers it from its record); native lists show all. */
export async function readDirectPairingInstallations(
  _client: object
): Promise<ReadonlySet<string>> {
  return NONE
}
