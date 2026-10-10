import type { WslUncPathInfo } from '../shared/wsl-paths'

// Why markers rather than an exit code: wsl.exe uses numeric exits for both guest results
// and host failures, so only a marker on stdout distinguishes "directory missing" from
// "wsl.exe could not answer".
const WSL_DIRECTORY_EXISTS_MARKER = '__ORCA_DIRECTORY_EXISTS__'
const WSL_DIRECTORY_MISSING_MARKER = '__ORCA_DIRECTORY_MISSING__'

/** Argv after the wsl.exe binary for the guest directory-existence probe. */
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

/** Null when neither marker appears, i.e. the guest never ran the test. */
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
