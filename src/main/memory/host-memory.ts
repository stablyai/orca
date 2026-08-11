import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostAvailableMemorySource, HostMemory } from '../../shared/types'

const MEMORY_PRESSURE_TIMEOUT_MS = 1_000
const MEMORY_PRESSURE_MAX_BUFFER = 64 * 1024
const KIB = 1024

let darwinAvailabilitySupported = true
let linuxAvailabilitySupported = true

export async function collectHostMemory(): Promise<HostMemory> {
  const total = nonNegativeNumber(os.totalmem())
  const free = Math.min(total, nonNegativeNumber(os.freemem()))
  const preferred = await readAvailableMemory(os.platform(), total)
  const available = Math.min(total, Math.max(free, preferred?.bytes ?? free))
  const used = Math.max(0, total - available)

  return {
    totalMemory: total,
    freeMemory: free,
    availableMemory: available,
    availableMemorySource: preferred?.source ?? 'free-memory',
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: nonNegativeNumber(os.loadavg()[0])
  }
}

export function fallbackHostMemory(): HostMemory {
  const total = nonNegativeNumber(os.totalmem())
  const free = Math.min(total, nonNegativeNumber(os.freemem()))
  const used = Math.max(0, total - free)
  return {
    totalMemory: total,
    freeMemory: free,
    availableMemory: free,
    availableMemorySource: 'free-memory',
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: nonNegativeNumber(os.loadavg()[0])
  }
}

export function parseDarwinAvailableMemory(stdout: string, total: number): number | null {
  const match = /System-wide memory free percentage:\s*(\d+)%/.exec(stdout)
  const percentage = Number.parseInt(match?.[1] ?? '', 10)
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || total <= 0) {
    return null
  }
  return Math.round((total * percentage) / 100)
}

export function parseLinuxAvailableMemory(meminfo: string): number | null {
  const match = /^MemAvailable:\s*(\d+)\s+kB$/m.exec(meminfo)
  const kib = Number.parseInt(match?.[1] ?? '', 10)
  if (!Number.isSafeInteger(kib) || kib < 0 || kib > Number.MAX_SAFE_INTEGER / KIB) {
    return null
  }
  return kib * KIB
}

async function readAvailableMemory(
  platform: NodeJS.Platform,
  total: number
): Promise<{ bytes: number; source: HostAvailableMemorySource } | null> {
  if (platform === 'darwin' && darwinAvailabilitySupported) {
    const bytes = await readDarwinAvailableMemory(total)
    if (bytes !== null) {
      return { bytes, source: 'memory-pressure' }
    }
  }
  if (platform === 'linux' && linuxAvailabilitySupported) {
    const bytes = await readLinuxAvailableMemory()
    if (bytes !== null) {
      return { bytes, source: 'proc-meminfo' }
    }
  }
  return null
}

async function readDarwinAvailableMemory(total: number): Promise<number | null> {
  try {
    const stdout = await execFileText('/usr/bin/memory_pressure', ['-Q'])
    const available = parseDarwinAvailableMemory(stdout, total)
    if (available !== null) {
      return available
    }
  } catch {
    // The built-in command is unavailable on older or restricted hosts.
  }
  darwinAvailabilitySupported = false
  return null
}

async function readLinuxAvailableMemory(): Promise<number | null> {
  try {
    const meminfo = await readFile(path.join(path.sep, 'proc', 'meminfo'), 'utf8')
    const available = parseLinuxAvailableMemory(meminfo)
    if (available !== null) {
      return available
    }
  } catch {
    // Non-procfs Linux environments fall back to Node's host value.
  }
  linuxAvailabilitySupported = false
  return null
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        maxBuffer: MEMORY_PRESSURE_MAX_BUFFER,
        timeout: MEMORY_PRESSURE_TIMEOUT_MS
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
