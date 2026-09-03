import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { queryWindowsProcessDescendants } from '../providers/windows-foreground-process-rows'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'

export type CodexTurnProcessSnapshot =
  | { platform: 'posix'; snapshot: DescendantSnapshot }
  | { platform: 'win32'; identities: ReadonlyMap<number, string> }

function windowsIdentity(row: {
  ppid: number
  name: string
  command: string
  executablePath?: string
}): string {
  return [row.ppid, row.name, row.command, row.executablePath ?? ''].join('\0')
}

export async function captureCodexTurnProcesses(
  rootPid: number
): Promise<CodexTurnProcessSnapshot | null> {
  if (process.platform === 'win32') {
    const descendants = await queryWindowsProcessDescendants(rootPid, { fresh: true })
    return descendants
      ? {
          platform: 'win32',
          identities: new Map(descendants.map((row) => [row.pid, windowsIdentity(row)]))
        }
      : null
  }
  const snapshot = await captureDescendantSnapshot(rootPid)
  return snapshot ? { platform: 'posix', snapshot } : null
}

function addedPosixDescendants(
  baseline: DescendantSnapshot,
  current: DescendantSnapshot
): DescendantSnapshot {
  const baselineRows = new Map(baseline.descendants.map((row) => [row.pid, row]))
  return {
    ...current,
    descendants: current.descendants.filter((row) => {
      const prior = baselineRows.get(row.pid)
      return prior?.startedAt !== row.startedAt || prior.pgid !== row.pgid
    })
  }
}

async function terminateWindowsAddedProcesses(
  rootPid: number,
  baseline: ReadonlyMap<number, string>
): Promise<boolean> {
  const current = await queryWindowsProcessDescendants(rootPid, { fresh: true })
  if (!current) {
    return false
  }
  const added = current.filter((row) => baseline.get(row.pid) !== windowsIdentity(row))
  const addedPids = new Set(added.map((row) => row.pid))
  const roots = added.filter((row) => !addedPids.has(row.ppid))
  await Promise.all(
    roots.map((row) => terminateWindowsProcessTree(row.pid, { site: 'codex-turn-added-roots' }))
  )
  const targetIdentities = new Map(added.map((row) => [row.pid, windowsIdentity(row)]))
  const remaining = await queryWindowsProcessDescendants(rootPid, { fresh: true })
  return (
    remaining !== null &&
    remaining.every((row) => targetIdentities.get(row.pid) !== windowsIdentity(row))
  )
}

export async function terminateCodexTurnProcesses(
  rootPid: number,
  baseline: CodexTurnProcessSnapshot | null
): Promise<boolean> {
  if (!baseline) {
    return false
  }
  if (baseline.platform === 'win32') {
    return terminateWindowsAddedProcesses(rootPid, baseline.identities)
  }
  const current = await captureDescendantSnapshot(rootPid)
  if (!current) {
    return false
  }
  const added = addedPosixDescendants(baseline.snapshot, current)
  return terminateDescendantSnapshotAndWait(added)
}
