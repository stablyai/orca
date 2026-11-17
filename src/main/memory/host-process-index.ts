import os from 'node:os'
import { runProcess } from '@orca/process-host'
import { enumerateWindowsProcessResources } from './windows-process-resource-collector'
import { getProcessMemoryMetric } from './process-memory-metric'
import { readDarwinProcessFootprints } from './darwin-process-footprint'
import { buildProcessIndex, parsePsOutput, type ProcIndex, type ProcRow } from './process-index'

const PS_EXEC_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 10 * 1024 * 1024

/** One whole-host process sweep with memory per process; spawns ps or PowerShell, so callers must bound the rate. */
export async function enumerateHostProcesses(): Promise<ProcIndex> {
  const platform = os.platform()
  const [rows, footprints] = await Promise.all([
    platform === 'win32' ? enumerateWindowsProcessResources() : enumerateUnix(),
    platform === 'darwin' ? readDarwinProcessFootprints() : Promise.resolve(null)
  ])
  return buildProcessIndex(rows, footprints, getProcessMemoryMetric(platform))
}

async function enumerateUnix(): Promise<ProcRow[]> {
  // Force dot decimals: parseFloat silently truncates locale-formatted comma values.
  try {
    const result = await runProcess({
      program: 'ps',
      args: ['-eo', 'pid=,ppid=,pcpu=,rss=,comm='],
      maxOutputBytes: PS_MAX_BUFFER,
      timeoutMs: PS_EXEC_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    if (result.timedOut || result.outputTruncated || result.code !== 0) {
      throw new Error(`ps exited ${result.code ?? 'on timeout'}`)
    }
    return parsePsOutput(result.stdout)
  } catch (err) {
    console.warn('[memory] ps enumeration failed', err)
    return []
  }
}
