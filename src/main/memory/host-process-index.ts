import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { enumerateWindowsProcessResources } from './windows-process-resource-collector'
import { getProcessMemoryMetric } from './process-memory-metric'
import { readDarwinProcessFootprints } from './darwin-process-footprint'
import { buildProcessIndex, parsePsOutput, type ProcIndex, type ProcRow } from './process-index'

const execFileAsync = promisify(execFile)
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
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,comm='], {
      maxBuffer: PS_MAX_BUFFER,
      timeout: PS_EXEC_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    return parsePsOutput(stdout)
  } catch (err) {
    console.warn('[memory] ps enumeration failed', err)
    return []
  }
}
