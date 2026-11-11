import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { freemem, loadavg, totalmem } from 'node:os'
import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { redactString } from '../observability/redactor'
import type { CompletedHangContext, HangMachineSnapshot } from './hang-observations'

function numberMatch(text: string, expression: RegExp): number | null {
  const match = expression.exec(text)
  const value = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : null
}
export function parseMacHangPressure(
  sysctl: string,
  vmStat: string
): Pick<
  HangMachineSnapshot,
  | 'systemMemorySwapTotalMB'
  | 'systemMemorySwapUsedMB'
  | 'systemMemoryCompressorMB'
  | 'systemMemoryPressureLevel'
  | 'systemMemoryStatusLevel'
> {
  const swap = (key: string): number | null => {
    const match = new RegExp(`\\b${key} = ([\\d.]+)([KMGT])\\b`).exec(sysctl)
    if (!match) {
      return null
    }
    const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[match[2]]
    const value = Number(match[1]) * (factor ?? Number.NaN)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  const pageSize = numberMatch(vmStat, /page size of (\d+) bytes/)
  const compressor = numberMatch(vmStat, /^Pages occupied by compressor:\s+(\d+)\.?\s*$/m)
  const compressorMB =
    pageSize !== null && compressor !== null ? (pageSize * compressor) / 1024 / 1024 : null
  return {
    systemMemorySwapTotalMB: swap('total'),
    systemMemorySwapUsedMB: swap('used'),
    systemMemoryCompressorMB:
      compressorMB !== null && Number.isFinite(compressorMB) ? compressorMB : null,
    systemMemoryPressureLevel: numberMatch(
      sysctl,
      /^kern\.memorystatus_vm_pressure_level:\s+(\d+)\s*$/m
    ),
    systemMemoryStatusLevel: numberMatch(sysctl, /^kern\.memorystatus_level:\s+(\d+)\s*$/m)
  }
}

export async function collectHangMachineSnapshot(
  signal: AbortSignal
): Promise<HangMachineSnapshot> {
  const loads = loadavg()
  const snapshot: HangMachineSnapshot = {
    startedAt: Date.now(),
    completedAt: null,
    systemMemoryTotalMB: totalmem() / 1024 / 1024,
    systemMemoryFreeMB: freemem() / 1024 / 1024,
    systemMemorySwapTotalMB: null,
    systemMemorySwapUsedMB: null,
    systemMemoryCompressorMB: null,
    systemMemoryPressureLevel: null,
    systemMemoryStatusLevel: null,
    load1: process.platform === 'win32' ? null : loads[0],
    load5: process.platform === 'win32' ? null : loads[1],
    load15: process.platform === 'win32' ? null : loads[2]
  }
  if (process.platform === 'darwin' && !signal.aborted) {
    const { runProcess } = await import('@orca/process-host')
    const commands = await Promise.allSettled([
      runProcess({
        program: '/usr/sbin/sysctl',
        args: ['vm.swapusage', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'],
        timeoutMs: 2_000,
        maxOutputBytes: 32 * 1024,
        signal
      }),
      runProcess({
        program: '/usr/bin/vm_stat',
        timeoutMs: 2_000,
        maxOutputBytes: 32 * 1024,
        signal
      })
    ])
    const outputs = commands.map((result) =>
      result.status === 'fulfilled' && !result.value.timedOut && !result.value.outputTruncated
        ? result.value.stdout
        : ''
    )
    Object.assign(snapshot, parseMacHangPressure(outputs[0], outputs[1]))
  }
  snapshot.completedAt = Date.now()
  return snapshot
}

export function readCompletedHangContext(
  tracePath: string | undefined
): CompletedHangContext[] | null {
  if (!tracePath) {
    return null
  }
  let fd: number | undefined
  try {
    fd = openSync(tracePath, 'r')
    const size = fstatSync(fd).size
    const offset = Math.max(0, size - 32 * 1024)
    const buffer = Buffer.allocUnsafe(Math.min(size, 32 * 1024))
    const bytes = readSync(fd, buffer, 0, buffer.length, offset)
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n')
    lines.pop()
    if (offset > 0) {
      lines.shift()
    }
    const spans: CompletedHangContext[] = []
    for (let index = lines.length - 1; index >= 0 && spans.length < 8; index--) {
      try {
        const data = JSON.parse(lines[index])
        if (
          data?.type !== 'effect-span' ||
          typeof data.name !== 'string' ||
          typeof data.startTimeUnixNano !== 'string' ||
          !/^\d{1,24}$/.test(data.startTimeUnixNano) ||
          typeof data.endTimeUnixNano !== 'string' ||
          !/^\d{1,24}$/.test(data.endTimeUnixNano)
        ) {
          continue
        }
        const startedAt = Number(data.startTimeUnixNano) / 1_000_000
        const completedAt = Number(data.endTimeUnixNano) / 1_000_000
        if (startedAt > completedAt) {
          continue
        }
        spans.push({
          name: sanitizeCrashReportString(redactString(data.name), 120).slice(0, 120),
          startedAt,
          completedAt
        })
      } catch {
        // Concurrent appends and interrupted writes can leave incomplete records.
      }
    }
    return spans.toReversed()
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
