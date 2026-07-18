import os from 'node:os'

// Why: node-pty silently falls back to WinPTY on Windows build numbers below 18309.
// Mirror node-pty's threshold exactly to prevent silently running on a broken backend.
export function isConptyAvailable(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const release = os.release()
  const parts = release.split('.')
  const build = parseInt(parts[2] ?? '0', 10)
  return build >= 18309
}
