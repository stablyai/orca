import type { WslUncPathInfo } from '../shared/wsl-paths'

// Exit codes conflate host failures with guest results; only stdout markers prove the guest answered.
const WSL_DIRECTORY_EXISTS_MARKER = '__ORCA_DIRECTORY_EXISTS__'
const WSL_DIRECTORY_MISSING_MARKER = '__ORCA_DIRECTORY_MISSING__'

export function getWslDirectoryProbeArgs(info: WslUncPathInfo): string[] {
  return [
    '-d',
    info.distro,
    '--exec',
    'sh',
    '-c',
    `if [ -d "$1" ]; then printf ${WSL_DIRECTORY_EXISTS_MARKER}; else printf ${WSL_DIRECTORY_MISSING_MARKER}; fi`,
    'sh',
    info.linuxPath
  ]
}

/** No marker means no authoritative guest answer. */
export function parseWslDirectoryProbeOutput(stdout: unknown): boolean | null {
  const output = String(stdout)
  if (output.includes(WSL_DIRECTORY_EXISTS_MARKER)) {
    return true
  }
  if (output.includes(WSL_DIRECTORY_MISSING_MARKER)) {
    return false
  }
  return null
}
