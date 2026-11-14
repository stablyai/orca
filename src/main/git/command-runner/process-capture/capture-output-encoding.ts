/** Validate a requested capture encoding before spawning, matching Node's execFile error. */
export function assertCaptureEncoding(encoding: string | null | undefined): void {
  if (encoding && encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unknown encoding: ${encoding}`)
  }
}

/** UTF-8 stays on the string path; every other encoding needs raw bytes to decode faithfully. */
export function capturesOutputBytes(encoding: string | null | undefined): boolean {
  return encoding != null && encoding !== 'utf8' && encoding !== 'utf-8'
}

function decodeCapturedBytes(bytes: Buffer, encoding: string | null | undefined): string | Buffer {
  return encoding && Buffer.isEncoding(encoding) ? bytes.toString(encoding) : bytes
}

/** Decode byte-captured output, stripping control markers from stderr without corrupting bytes. */
export function decodeCapturedOutput(
  result: { stdoutBytes?: Buffer; stderrBytes?: Buffer },
  encoding: string | null | undefined,
  stripControl: ((text: string) => string) | undefined
): { stdout: string | Buffer; stderr: string | Buffer } {
  const stderrBytes = result.stderrBytes ?? Buffer.alloc(0)
  return {
    stdout: decodeCapturedBytes(result.stdoutBytes ?? Buffer.alloc(0), encoding),
    stderr: decodeCapturedBytes(
      stripControl
        ? // Why: Latin-1 strips ASCII control markers without changing arbitrary bytes.
          Buffer.from(stripControl(stderrBytes.toString('latin1')), 'latin1')
        : stderrBytes,
      encoding
    )
  }
}
