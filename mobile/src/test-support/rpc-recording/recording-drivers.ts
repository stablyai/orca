/**
 * The suites that write goldens. A golden's bytes come from one of these and from what it imports,
 * so these are the only test files `recorderSha256` pins: a suite that merely reads goldens, or
 * writes one to a scratch directory, cannot put an observation in a recorded file.
 *
 * `scripts/rpc-recording.mts` records exactly this list, so a suite that is added here and nowhere
 * else still records, and one added there and not here does not exist.
 */
export const RECORDING_DRIVERS = ['pilot-recordings.test.ts', 'family-recordings.test.ts'] as const
