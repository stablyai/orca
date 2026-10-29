// Use one driver list for recording and dependency boundaries; read-only replay suites cannot create golden observations.
export const RECORDING_DRIVERS = ['pilot-recordings.test.ts', 'family-recordings.test.ts'] as const
