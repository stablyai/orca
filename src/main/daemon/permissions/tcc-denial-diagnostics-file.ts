// Local-only record of folder-denial captures that support can ask a user to attach; never uploaded.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getLogsDirectory } from '../../observability/logs-directory'

const TCC_DENIAL_DIAGNOSTICS_MAX_CAPTURES = 10
const TCC_DENIAL_DIAGNOSTICS_MAX_BYTES = 256 * 1024

export function tccDenialDiagnosticsPath(): string {
  return join(getLogsDirectory(), 'terminal-folder-denials.ndjson')
}

/** Newest captures win; each entry is one NDJSON line, and an oversized newest entry is dropped. */
function appendCapture(existing: string, entry: string): string {
  const earlier = existing.split('\n').filter((line) => line.length > 0)
  if (Buffer.byteLength(entry) + 1 > TCC_DENIAL_DIAGNOSTICS_MAX_BYTES) {
    return earlier.map((line) => `${line}\n`).join('')
  }
  const lines = [...earlier, entry].slice(-TCC_DENIAL_DIAGNOSTICS_MAX_CAPTURES)
  let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0)
  while (lines.length > 0 && bytes > TCC_DENIAL_DIAGNOSTICS_MAX_BYTES) {
    bytes -= Buffer.byteLength(lines.shift() ?? '') + 1
  }
  return lines.map((line) => `${line}\n`).join('')
}

let writeChain: Promise<void> = Promise.resolve()

/** Serialized read-trim-replace so concurrent captures cannot drop each other. */
export function writeTccDenialDiagnostics(
  entry: Record<string, unknown>,
  filePath: string = tccDenialDiagnosticsPath()
): Promise<void> {
  const write = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    const existing = await readFile(filePath, 'utf8').catch(() => '')
    const tempPath = `${filePath}.${process.pid}.tmp`
    await writeFile(tempPath, appendCapture(existing, JSON.stringify(entry)), { mode: 0o600 })
    await rename(tempPath, filePath)
  }
  writeChain = writeChain.then(write).catch(() => {
    // A diagnostics file that cannot be written must not affect terminals.
  })
  return writeChain
}
