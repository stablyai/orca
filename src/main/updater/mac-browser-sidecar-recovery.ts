import { lstat, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '@orca/process-host'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import type { UpdateInstallBlocker } from '../../shared/update-status-types'
import { getMacUpdateRunningInstances } from '../macos-update-running-instances'

type ProcessRow = {
  pid: number
  parentPid: number
  uid: number
  startedAt: string
  command: string
}

async function readProcesses(pids: number[]): Promise<ProcessRow[]> {
  if (pids.length === 0) {
    return []
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-ww', '-p', pids.join(','), '-o', 'pid=,ppid=,uid=,lstart=,command='],
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1024,
    killOnOutputLimit: true
  })
  if (result.timedOut || result.outputTruncated || (result.code !== 0 && result.code !== 1)) {
    throw new Error('Could not inspect update blockers')
  }
  return result.stdout.split('\n').flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line
      )
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            uid: Number(match[3]),
            startedAt: match[4],
            command: match[5]
          }
        ]
      : []
  })
}

function sidecarProfile(command: string, executable: string): string | null {
  if (!command.startsWith(`${executable} `)) {
    return null
  }
  const args = command.slice(executable.length + 1)
  // Match only the isolated browser launch, never a user's ordinary serve profile.
  const match =
    /^--serve --serve-port \d+ --serve-json --serve-no-pairing (?:--password-store=basic --use-mock-keychain )?--user-data-dir=(\/tmp\/orcad-browser-[\w-]+)$/.exec(
      args
    )
  return match?.[1] ?? null
}

async function isOwnedSidecar(profile: string, pid: number, uid: number): Promise<boolean> {
  try {
    const info = await lstat(profile)
    if (info.uid !== uid || !info.isDirectory()) {
      return false
    }
    const metadataPath = getRuntimeMetadataPath(profile)
    const metadataInfo = await lstat(metadataPath)
    if (!metadataInfo.isFile() || metadataInfo.uid !== uid || metadataInfo.size > 64 * 1024) {
      return false
    }
    const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'))
    return !!metadata && typeof metadata === 'object' && 'pid' in metadata && metadata.pid === pid
  } catch {
    return false
  }
}

export type MacBrowserRecoveryDeps = {
  readProcesses?: typeof readProcesses
  isOwnedSidecar?: typeof isOwnedSidecar
  signal?: (pid: number) => void
  listBlockers?: () => Promise<number[]>
  sleep?: (ms: number) => Promise<void>
}

/** Recover old browser children whose owner has exited; keep all uncertain processes as blockers. */
export async function recoverMacBrowserSidecars(
  executable: string,
  blockers: number[],
  deps: MacBrowserRecoveryDeps = {}
): Promise<number[]> {
  if (process.platform !== 'darwin' || blockers.length === 0) {
    return blockers
  }
  const read = deps.readProcesses ?? readProcesses
  const verify = deps.isOwnedSidecar ?? isOwnedSidecar
  let rows: ProcessRow[]
  try {
    rows = await read(blockers)
  } catch {
    return blockers
  }
  const signalled: number[] = []
  const signal = deps.signal ?? ((pid: number) => process.kill(pid, 'SIGTERM'))
  for (const row of rows) {
    const profile = sidecarProfile(row.command, executable)
    if (
      !blockers.includes(row.pid) ||
      row.parentPid !== 1 ||
      row.uid !== process.getuid?.() ||
      !profile
    ) {
      continue
    }
    if (!(await verify(profile, row.pid, row.uid))) {
      continue
    }
    try {
      // Recheck after filesystem I/O so a changed process cannot inherit the old verdict.
      const [current] = await read([row.pid])
      if (
        !current ||
        current.parentPid !== 1 ||
        current.uid !== row.uid ||
        current.startedAt !== row.startedAt ||
        current.command !== row.command
      ) {
        continue
      }
      signal(row.pid)
      signalled.push(row.pid)
    } catch {
      // A missing or inaccessible process is never evidence that installation is safe.
    }
  }
  if (signalled.length === 0) {
    return blockers
  }
  const list = deps.listBlockers ?? (() => getMacUpdateRunningInstances(executable))
  const deadline = Date.now() + 5_000
  for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt++) {
    await (deps.sleep ?? delay)(250)
    const remaining = await list()
    if (!remaining.some((pid) => signalled.includes(pid))) {
      return remaining
    }
  }
  return await list()
}

export async function describeMacUpdateBlockers(
  executable: string,
  pids: number[]
): Promise<UpdateInstallBlocker[]> {
  if (process.platform !== 'darwin') {
    return pids.map((pid) => ({ pid, kind: 'unknown' }))
  }
  let rows: ProcessRow[] = []
  try {
    rows = await readProcesses(pids)
  } catch {
    // The native registry is still authoritative when process inspection fails.
  }
  return pids.map((pid) => {
    const row = rows.find((candidate) => candidate.pid === pid)
    const command = row?.command
    const kind =
      !command?.startsWith(`${executable} `) && command !== executable
        ? 'unknown'
        : sidecarProfile(command, executable)
          ? 'browser'
          : command.slice(executable.length).split(/\s+/).includes('--serve')
            ? 'server'
            : 'window'
    return { pid, kind }
  })
}
