import { readFileSync } from 'node:fs'

/**
 * A value that changes when a pid is handed to another process: the start time on Linux.
 * Null where it is not cheap to read; callers then fall back to comparing app names.
 */
export function processStartIdentity(pid: number): string | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Why after the last ')': the command name (field 2) can itself contain spaces and ')'.
    // The rest starts at field 3, so starttime (field 22) is index 19.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}
