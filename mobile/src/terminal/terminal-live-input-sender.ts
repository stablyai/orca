export type TerminalLiveInputSender = (
  handle: string,
  bytes: string,
  // Mirror bytes were already drawn locally at keystroke time.
  options?: { readonly predicted?: boolean }
) => Promise<boolean>
