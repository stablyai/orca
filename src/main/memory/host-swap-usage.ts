import type { runProcess } from '@orca/process-host'
import path from 'node:path'
import type { HostResourcesSnapshot } from '../../shared/host-resources'

const SWAP_TIMEOUT_MS = 1_000
const SWAP_MAX_OUTPUT_BYTES = 65_536
const KIB = 1024
// sysctl vm.swapusage uses power-of-two K/M/G/T units.
const BYTE_UNIT: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4
}

type HostSwapUsage = NonNullable<HostResourcesSnapshot['memory']['swap']>

export type HostSwapReaders = {
  platform: () => NodeJS.Platform
  readFile: (file: string, encoding: 'utf8') => Promise<string>
  runProcess: typeof runProcess
}

export function parseLinuxSwap(meminfo: string): HostSwapUsage | null {
  const totalKib = meminfoKib(meminfo, 'SwapTotal')
  const freeKib = meminfoKib(meminfo, 'SwapFree')
  if (totalKib === null || freeKib === null || totalKib === 0) {
    return null
  }
  const totalBytes = kibToBytes(totalKib)
  const freeBytes = kibToBytes(freeKib)
  if (totalBytes === null || freeBytes === null) {
    return null
  }
  const usedBytes = Math.max(0, totalBytes - Math.min(totalBytes, freeBytes))
  return swapUsage(usedBytes, totalBytes)
}

export function parseDarwinSwapUsage(stdout: string): HostSwapUsage | null {
  const totalBytes = parseScaledBytes(stdout, 'total')
  const used = parseScaledBytes(stdout, 'used')
  if (totalBytes === null || used === null || totalBytes === 0) {
    return null
  }
  return swapUsage(Math.min(totalBytes, Math.max(0, used)), totalBytes)
}

export async function readHostSwap(readers: HostSwapReaders): Promise<HostSwapUsage | null> {
  const platform = readers.platform()
  if (platform === 'linux') {
    return readLinuxSwap(readers)
  }
  if (platform === 'darwin') {
    return readDarwinSwap(readers)
  }
  return null
}

async function readLinuxSwap(readers: HostSwapReaders): Promise<HostSwapUsage | null> {
  try {
    const meminfo = await readers.readFile(path.join(path.sep, 'proc', 'meminfo'), 'utf8')
    return parseLinuxSwap(meminfo)
  } catch {
    return null
  }
}

async function readDarwinSwap(readers: HostSwapReaders): Promise<HostSwapUsage | null> {
  try {
    const result = await readers.runProcess({
      program: '/usr/sbin/sysctl',
      args: ['vm.swapusage'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: SWAP_MAX_OUTPUT_BYTES,
      timeoutMs: SWAP_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    return parseDarwinSwapUsage(result.stdout)
  } catch {
    return null
  }
}

function meminfoKib(meminfo: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s*(\\d+)\\s+kB\\s*$`, 'm').exec(meminfo)
  if (!match?.[1]) {
    return null
  }
  const kib = Number(match[1])
  return Number.isSafeInteger(kib) && kib >= 0 ? kib : null
}

function kibToBytes(kib: number): number | null {
  if (kib > Number.MAX_SAFE_INTEGER / KIB) {
    return null
  }
  return kib * KIB
}

function parseScaledBytes(source: string, label: string): number | null {
  const match = new RegExp(`(?:^|\\s)${label}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*([KMGT])B?`, 'i').exec(
    source
  )
  if (!match?.[1] || !match[2]) {
    return null
  }
  const magnitude = Number(match[1])
  const unit = BYTE_UNIT[match[2].toUpperCase()]
  if (!Number.isFinite(magnitude) || magnitude < 0 || unit === undefined) {
    return null
  }
  const bytes = Math.round(magnitude * unit)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

function swapUsage(usedBytes: number, totalBytes: number): HostSwapUsage {
  return { usedBytes, totalBytes, usedPercent: usedPercent(usedBytes, totalBytes) }
}

function usedPercent(usedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) {
    return 0
  }
  return clampPercent((usedBytes / totalBytes) * 100)
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}
