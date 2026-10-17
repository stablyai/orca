const DYLD_LOAD_FAILURE = /dyld|Symbol not found|Library not loaded/i

// Why: a serve-sim-bin built for a newer macOS than the host fails at dyld with a raw
// symbol dump; replace it with a readable explanation and keep the original below.
export function describeServeSimHelperFailure(message: string): string | null {
  if (!DYLD_LOAD_FAILURE.test(message)) {
    return null
  }
  return `The iOS Simulator helper could not start because it links against system libraries this macOS does not provide. Update macOS to use it; Android emulators are unaffected.\n\n${message}`
}
