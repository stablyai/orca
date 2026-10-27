import { readFileSync, statSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import {
  parseLinuxBootTimeSeconds,
  parseLinuxProcStartTicks
} from '../../daemon/daemon-process-start-time'
import { getPsProcessIdentity } from '../../daemon/daemon-process-identity-query'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../../windows-native-registry'
import { readWindowsProcessCreationTime } from '../../windows/windows-process-table'

let bootIdentity: string | null | undefined
let machineIdentity: string | null | undefined
let ownProcessIdentity: string | null | undefined

/** A boot change proves exit only when the record belongs to this machine. */
export function profileStateAccessMachineIdentity(): string | null {
  if (machineIdentity !== undefined) {
    return machineIdentity
  }
  machineIdentity = null
  try {
    if (process.platform === 'linux') {
      const value = readFileSync('/etc/machine-id', 'utf8').trim()
      machineIdentity = /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value) ? value : null
    } else if (process.platform === 'win32') {
      const registry = loadWindowsNativeRegistry()
      const values = registry.getRegistryKey(registry.HK.LM, 'SOFTWARE\\Microsoft\\Cryptography')
      const entry = Object.entries(values ?? {}).find(
        ([name]) => name.toLowerCase() === 'machineguid'
      )?.[1]
      const value =
        entry?.type === WINDOWS_REG_SZ && typeof entry.value === 'string'
          ? entry.value.trim().toLowerCase()
          : ''
      machineIdentity =
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) &&
        value !== '00000000-0000-0000-0000-000000000000'
          ? `win32-machine-guid:${value}`
          : null
    } else if (process.platform === 'darwin') {
      // kern.hostuuid does not exist on macOS (#29259).
      const result = runProcessSync({
        program: '/usr/sbin/ioreg',
        args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024
      })
      machineIdentity = result.code === 0 ? parseDarwinPlatformUuid(result.stdout) : null
    }
  } catch {
    // Missing identity cannot prove ownership across reboot.
  }
  return machineIdentity
}

/** Match the lowercase UUID read by the SSH machine-home probe. */
export function parseDarwinPlatformUuid(ioregOutput: string): string | null {
  const value = /"IOPlatformUUID"\s*=\s*"([^"]*)"/u.exec(ioregOutput)?.[1]?.toLowerCase()
  return value &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value) &&
    !/^[0-]+$/u.test(value)
    ? value
    : null
}

/** Boot identity survives hostname changes without conflating machines sharing a profile. */
export function profileStateAccessBootIdentity(): string | null {
  if (bootIdentity !== undefined) {
    return bootIdentity
  }
  bootIdentity = null
  try {
    if (process.platform === 'linux') {
      bootIdentity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
    } else if (process.platform === 'darwin') {
      const result = runProcessSync({
        program: '/usr/sbin/sysctl',
        args: ['-n', 'kern.bootsessionuuid'],
        timeoutMs: 1_000,
        maxOutputBytes: 1024
      })
      bootIdentity = result.code === 0 ? result.stdout.trim() || null : null
    }
  } catch {
    // Fall back conservatively to hostname/PID checks.
  }
  return bootIdentity
}

export function profileStateAccessProcessIdentity(pid: number): string | null {
  if (pid !== process.pid) {
    return readProcessIdentity(pid)
  }
  if (ownProcessIdentity === undefined) {
    ownProcessIdentity = readProcessIdentity(pid)
  }
  return ownProcessIdentity
}

function readProcessIdentity(pid: number): string | null {
  if (process.platform === 'win32') {
    const startedAtMs = readWindowsProcessCreationTime(pid)
    return startedAtMs === null ? null : `win32-creation-ms:${startedAtMs}`
  }
  if (process.platform === 'linux') {
    try {
      const ticks = parseLinuxProcStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      return Number.isSafeInteger(ticks) && ticks >= 0 ? `linux-start-ticks:${ticks}` : null
    } catch {
      return null
    }
  }
  if (process.platform !== 'darwin') {
    return null
  }
  const startedAtMs = getPsProcessIdentity(pid, { utc: true })?.startedAtMs
  // Local wall times are ambiguous during daylight-saving transitions.
  return startedAtMs == null ? null : `darwin-utc-start-ms:${startedAtMs}`
}

/** Null where boot start is unknown, which keeps every record judged as before. */
export function currentLinuxBootStartedAtMs(): number | null {
  try {
    const seconds = parseLinuxBootTimeSeconds(readFileSync('/proc/stat', 'utf8'))
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
  } catch {
    return null
  }
}

/** A record changed after this boot began cannot be this machine's from an earlier boot. */
export function profileStateAccessWrittenThisBoot(path: string): boolean {
  const bootStartedAtMs = currentLinuxBootStartedAtMs()
  try {
    return bootStartedAtMs !== null && statSync(path).mtimeMs > bootStartedAtMs
  } catch {
    return false
  }
}
