/**
 * Guest-side detection and repair of the `WSLInterop` binfmt_misc entry.
 *
 * Why: on WSL < 3.0.1 a graceful stop of ANY systemd distro (including the
 * ~15 s idle stop) writes -1 to binfmt_misc/status, which deletes every entry
 * VM-wide. Every other running distro then fails to exec Windows binaries
 * (`code .`, `explorer.exe`, Orca's WSL CLI bridge) with "Exec format error".
 * Fixed upstream in microsoft/WSL#13885. The registry is shared by all
 * distros, so one repair restores every one of them.
 */

export type WslInteropProbeResult =
  | { state: 'present' }
  /** binfmt_misc is not mounted, so there is nothing Orca can safely restore. */
  | { state: 'unmounted' }
  | { state: 'missing'; interopDisabled: boolean }
  | { state: 'unknown' }

const MARKER = 'orca-wsl-interop:'
const BINFMT_DIR = '/proc/sys/fs/binfmt_misc'

// Why both names: some WSL builds register `WSLInterop-late` after systemd starts.
const PRESENT_TEST = `[ -e ${BINFMT_DIR}/WSLInterop ] || [ -e ${BINFMT_DIR}/WSLInterop-late ]`

/** Read-only; runs as the default user. wsl.conf is only printed when it matters. */
export const WSL_INTEROP_PROBE_SCRIPT = [
  `if [ ! -e ${BINFMT_DIR}/register ]; then echo '${MARKER}unmounted'`,
  `elif ${PRESENT_TEST}; then echo '${MARKER}present'`,
  `else echo '${MARKER}missing'; echo '${MARKER}conf'; cat /etc/wsl.conf 2>/dev/null; fi`
].join('\n')

/**
 * Idempotent; runs as root. Re-checks so a concurrent repair (or WSL itself)
 * never gets a duplicate entry. Never `systemctl restart systemd-binfmt`:
 * that flushes every entry first. Flags match WSL's own `P` registration; `F`
 * would pin the repairing distro's /init open for the life of the VM.
 */
export const WSL_INTEROP_REPAIR_SCRIPT = [
  `if ${PRESENT_TEST}; then echo '${MARKER}present'; exit 0; fi`,
  // No trailing newline: busybox printf writes it separately and the kernel rejects that write
  // with EINVAL after registering. The re-check below, not the write status, is the verdict.
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
