/** The empty stdout/stderr execFile reports for an encoding: a Buffer for 'buffer' or null, else a string. */
export function emptyExecFileOutput(options: { encoding?: unknown }): string | Buffer {
  return options.encoding === 'buffer' || options.encoding === null ? Buffer.alloc(0) : ''
}

/** The promisified execFile shape: a result object carrying both streams instead of separate arguments. */
export function isExecFileResultObject(
  value: unknown
): value is { stdout: string | Buffer; stderr: string | Buffer } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    'stdout' in value &&
    'stderr' in value
  )
}
