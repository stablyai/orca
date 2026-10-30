import { stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex,
  type ProcessIdentityRow
} from '../../shared/process-table-index'
import { getProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import type { CodexComputerUseRuntimeStatus } from '../../shared/codex-computer-use-runtime'

type Row = ProcessIdentityRow & { command: string }
type Host = { pid: number; executable: string }

export function findCodexComputerUseHosts(rows: readonly Row[], rootPid: number): Host[] {
  const index = getProcessTableIndex(rows)
  const descendants = collectDescendantsFromIndex(index, rootPid)
  const root = index.byPid.get(rootPid)
  const codex = [...(root ? [{ ...root, depth: 0 }] : []), ...descendants]
    .filter(
      (row) =>
        recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })
          ?.agent === 'codex'
    )
    .sort((left, right) => left.depth - right.depth)[0]
  if (!codex) {
    return []
  }
  return collectDescendantsFromIndex(
    index,
    codex.pid,
    (row) =>
      recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })?.agent ===
      'codex'
  ).flatMap((row) => {
    const executable = row.command.match(/^(\S+\/cua_node\/bin\/node_repl)(?:\s|$)/)?.[1]
    if (!executable) {
      return []
    }
    return [{ pid: row.pid, executable }]
  })
}

async function executableIdentity(path: string): Promise<string | null> {
  return stat(path).then(
    (entry) => (entry.isFile() ? `${entry.dev}:${entry.ino}` : null),
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  )
}

export async function inspectCodexComputerUseMappings(
  hosts: readonly Host[],
  output: string
): Promise<CodexComputerUseRuntimeStatus> {
  const mappings = new Map<number, string>()
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1))
    }
    if (pid !== null && line.startsWith('n') && line.endsWith('/node_repl')) {
      mappings.set(pid, line.slice(1))
    }
  }
  let inspected = 0
  for (const host of hosts) {
    const mapped = mappings.get(host.pid)
    if (!mapped) {
      continue
    }
    const currentIdentity = await executableIdentity(host.executable)
    if (!currentIdentity) {
      continue
    }
    const mappedIdentity = await executableIdentity(mapped)
    if (mappedIdentity !== currentIdentity) {
      return { status: 'stale' }
    }
    inspected += 1
  }
  return { status: hosts.length > 0 && inspected === hosts.length ? 'current' : 'unavailable' }
}

export async function inspectPaneCodexComputerUseRuntime(
  rootPid: number
): Promise<CodexComputerUseRuntimeStatus> {
  if (process.platform !== 'darwin') {
    return { status: 'unsupported' }
  }
  const rows = await getProcessTableSnapshot()
  const hosts = findCodexComputerUseHosts(rows, rootPid)
  if (hosts.length === 0 || hosts.length > 32) {
    return { status: 'unavailable' }
  }
  const result = await runProcess({
    program: '/usr/sbin/lsof',
    args: ['-n', '-a', '-p', hosts.map((host) => host.pid).join(','), '-d', 'txt', '-Fpn'],
    cwd: '/',
    timeoutMs: 3000,
    maxOutputBytes: 512 * 1024
  })
  if (result.code !== 0 || result.timedOut) {
    return { status: 'unavailable' }
  }
  return inspectCodexComputerUseMappings(hosts, result.stdout)
}
