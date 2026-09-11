export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024 // 4 MiB cap enforced before upload
// Why: the trace family alone routinely fills the whole cap on a busy session, which
// would otherwise leave zero bytes for the daemon lifecycle log. Only the bytes the
// daemon family actually uses are taken from the trace family's budget.
export const DAEMON_LOG_RESERVE_BYTES = 256 * 1024
