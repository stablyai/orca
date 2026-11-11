import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import type { HostMachine } from '../../../../shared/host-machine-line'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import {
  MAC_FALLBACK_MACHINE,
  WINDOWS_FALLBACK_MACHINE,
  parseLinuxDmi,
  parseMacHardwareProfile,
  parseWindowsComputerSystem
} from './host-machine-probe-parsing'
import { MACHINE_NAME_RETRY_INTERVAL_MS } from './runtime-machine-name'

const MAC_SYSTEM_PROFILER = '/usr/sbin/system_profiler'
// Boot load can stall the probe for seconds; status publishers bound their own wait.
const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024
const WINDOWS_COMPUTER_SYSTEM_COMMAND =
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
  '$c = Get-CimInstance Win32_ComputerSystem; $o = Get-CimInstance Win32_OperatingSystem; ' +
  '[pscustomobject]@{ PCSystemType = $c.PCSystemType; Model = $c.Model; Manufacturer = $c.Manufacturer; ' +
  'SystemFamily = $c.SystemFamily; ProductType = $o.ProductType } | ConvertTo-Json -Compress'
const LINUX_DMI_DIR = '/sys/class/dmi/id'

/** `final` marks an answer worth memoizing; a fallback from a failed probe is retried later. */
type HostMachineDetection = { machine: HostMachine | null; final: boolean }

async function runProbe(program: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program,
      args,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

async function readDmiField(name: string): Promise<string | null> {
  try {
    return (await readFile(`${LINUX_DMI_DIR}/${name}`, 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function detectHostMachine(): Promise<HostMachineDetection> {
  if (process.platform === 'darwin') {
    const stdout = await runProbe(MAC_SYSTEM_PROFILER, ['SPHardwareDataType', '-json'])
    const machine = stdout === null ? null : parseMacHardwareProfile(stdout)
    return { machine: machine ?? MAC_FALLBACK_MACHINE, final: machine !== null }
  }
  if (process.platform === 'win32') {
    const stdout = await runProbe(windowsPowerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_COMPUTER_SYSTEM_COMMAND
    ])
    const machine = stdout === null ? null : parseWindowsComputerSystem(stdout)
    return { machine: machine ?? WINDOWS_FALLBACK_MACHINE, final: machine !== null }
  }
  if (process.platform === 'linux') {
    const [chassisType, productName, productFamily, sysVendor] = await Promise.all(
      ['chassis_type', 'product_name', 'product_family', 'sys_vendor'].map(readDmiField)
    )
    return {
      machine: parseLinuxDmi({ chassisType, productName, productFamily, sysVendor }),
      final: true
    }
  }
  return { machine: null, final: true }
}

// One host per process; every runtime shares this probe.
let lookup: Promise<void> | null = null
let detected: HostMachine | null = null
let lastFailedLookupAt: number | null = null

function lookupHostMachine(): Promise<void> {
  if (lookup) {
    return lookup
  }
  if (
    lastFailedLookupAt !== null &&
    Date.now() - lastFailedLookupAt < MACHINE_NAME_RETRY_INTERVAL_MS
  ) {
    return Promise.resolve()
  }
  const current: Promise<void> = detectHostMachine().then(
    (detection) => {
      detected = detection.machine
      if (!detection.final) {
        lastFailedLookupAt = Date.now()
        lookup = null
      }
    },
    () => {
      lastFailedLookupAt = Date.now()
      lookup = null
    }
  )
  lookup = current
  return current
}

/** Starts the probe on first use; a probe outliving `budgetMs` answers null now and its result on a later read. */
export async function readHostMachineWithin(budgetMs: number): Promise<HostMachine | null> {
  await withTimeout(lookupHostMachine(), budgetMs, undefined)
  return detected
}
