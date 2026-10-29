import { LSOF_NONBLOCKING_ARGS } from '../../shared/lsof-nonblocking-args'
import { runPortScanCommand } from './port-scan-command-client'
import type { ProcessMetadata } from './local-workspace-port-scan-state'

export async function loadDarwinProcessMetadata(
  pids: Set<number>
): Promise<Map<number, ProcessMetadata>> {
  const result = new Map<number, ProcessMetadata>()
  const pidList = Array.from(pids).join(',')
  if (!pidList) {
    return result
  }

  // Why (#11161): sequential, not Promise.all — the probe worker dispatches one
  // command at a time, so issuing both at once would only queue the second.
  const cwdOutput = await runPortScanCommand(
    '/usr/sbin/lsof',
    ['-O', ...LSOF_NONBLOCKING_ARGS, '-a', '-p', pidList, '-d', 'cwd', '-Fn'],
    'attribution'
  )
  const commandOutput = await runPortScanCommand(
    '/bin/ps',
    ['-p', pidList, '-o', 'pid=', '-o', 'command='],
    'attribution'
  )

  let currentPid: number | null = null
  for (const line of cwdOutput.stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1), 10)
      currentPid = Number.isFinite(pid) ? pid : null
    } else if (line.startsWith('n') && currentPid != null) {
      result.set(currentPid, { ...result.get(currentPid), cwd: line.slice(1) || undefined })
    }
  }

  for (const line of commandOutput.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) {
      continue
    }
    const pid = Number.parseInt(match[1], 10)
    result.set(pid, { ...result.get(pid), commandLine: match[2].trim() || undefined })
  }

  return result
}
