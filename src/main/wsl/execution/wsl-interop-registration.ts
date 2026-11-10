/** WSL <3.0.1 systemd distro stops wipe VM-wide binfmt entries, breaking Windows-binary exec in other distros. One shared-registry repair restores all (microsoft/WSL#13885). */

export type WslInteropProbeResult =
  | { state: 'present' }
  /** binfmt_misc is not mounted, so there is nothing Orca can safely restore. */
  | { state: 'unmounted' }
  | { state: 'missing'; interopDisabled: boolean }
  | { state: 'unknown' }

const MARKER = 'orca-wsl-interop:'
const BINFMT_DIR = '/proc/sys/fs/binfmt_misc'

// Some WSL builds register WSLInterop-late after systemd startup.
const PRESENT_TEST = `[ -e ${BINFMT_DIR}/WSLInterop ] || [ -e ${BINFMT_DIR}/WSLInterop-late ]`

/** Read-only; runs as the default user. wsl.conf is only printed when it matters. */
export const WSL_INTEROP_PROBE_SCRIPT = [
  `if [ ! -e ${BINFMT_DIR}/register ]; then echo '${MARKER}unmounted'`,
  `elif ${PRESENT_TEST}; then echo '${MARKER}present'`,
  `else echo '${MARKER}missing'; echo '${MARKER}conf'; cat /etc/wsl.conf 2>/dev/null; fi`
].join('\n')

/** Root repair rechecks to avoid duplicate entries. Never restart systemd-binfmt (flushes all). Match WSL P flags; F would pin this distro's /init for the VM lifetime. */
export const WSL_INTEROP_REPAIR_SCRIPT = [
  `if ${PRESENT_TEST}; then echo '${MARKER}present'; exit 0; fi`,
  // Omit newline: BusyBox writes it separately and gets EINVAL after successful registration. Judge the recheck, not write status.
  `printf ':WSLInterop:M::MZ::/init:P' > ${BINFMT_DIR}/register`,
  `if ${PRESENT_TEST}; then echo '${MARKER}repaired'; else exit 1; fi`
].join('\n')

function markerLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(MARKER))
}

export function parseWslInteropProbeOutput(stdout: string): WslInteropProbeResult {
  const [first] = markerLines(stdout)
  if (first === `${MARKER}present`) {
    return { state: 'present' }
  }
  if (first === `${MARKER}unmounted`) {
    return { state: 'unmounted' }
  }
  if (first === `${MARKER}missing`) {
    const confStart = stdout.indexOf(`${MARKER}conf`)
    const conf = confStart !== -1 ? stdout.slice(confStart + `${MARKER}conf`.length) : ''
    return { state: 'missing', interopDisabled: isWslConfInteropDisabled(conf) }
  }
  return { state: 'unknown' }
}

export function parseWslInteropRepairOutput(stdout: string): 'present' | 'repaired' | 'unknown' {
  const [first] = markerLines(stdout)
  if (first === `${MARKER}present`) {
    return 'present'
  }
  return first === `${MARKER}repaired` ? 'repaired' : 'unknown'
}

const FALSE_VALUES = new Set(['false', '0', 'no', 'off'])

/** True when /etc/wsl.conf sets `[interop] enabled = false`. */
export function isWslConfInteropDisabled(conf: string): boolean {
  let section = ''
  let disabled = false
  for (const rawLine of conf.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, '').trim()
    const header = /^\[([^\]]*)\]$/.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    if (section !== 'interop') {
      continue
    }
    const entry = /^([^=]+)=(.*)$/.exec(line)
    if (!entry || entry[1].trim().toLowerCase() !== 'enabled') {
      continue
    }
    // Last assignment wins, as in any INI reader.
    const value = entry[2]
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
    disabled = FALSE_VALUES.has(value)
  }
  return disabled
}
