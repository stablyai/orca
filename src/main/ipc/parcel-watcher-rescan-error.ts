// Why: FSEvents MustScanSubDirs (dropped or coalesced events) loses paths but keeps the
// stream running; retiring the watch on it left large roots unwatched for the session.
const RESCAN_REQUIRED_SUFFIX = 'File system must be re-scanned.'

export function isParcelWatcherRescanRequiredError(error: Error): boolean {
  return error.message.endsWith(RESCAN_REQUIRED_SUFFIX)
}
