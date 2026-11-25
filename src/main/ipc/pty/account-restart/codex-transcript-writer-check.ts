import { runProcess } from '@orca/process-host'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { captureDescendantSnapshot } from '../../../pty/process-retirement/pty-descendant-termination'
import type { CodexRestartOccupant } from './codex-account-restart-types'

type ExecResult = { code: number | null; stdout: string; stderr: string }
type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

type TranscriptWriterCheckDeps = {
  platform: NodeJS.Platform
  exec: Exec
  findProcHolders: (path: string) => Promise<readonly number[] | null>
}

export type CodexTranscriptWriterDeps = {
  /** Null means the host cannot verify who holds the transcript open. */
  listTranscriptHolders?: ((transcriptPath: string) => Promise<readonly number[] | null>) | null
  captureDescendants?: typeof captureDescendantSnapshot
}

export function resolveTranscriptHolderLookup(deps: CodexTranscriptWriterDeps) {
  if (deps.listTranscriptHolders !== undefined) {
    return deps.listTranscriptHolders
  }
  return process.platform === 'darwin' || process.platform === 'linux'
    ? listCodexTranscriptHolders
    : null
}

export async function ownsTranscriptWriters(
  deps: CodexTranscriptWriterDeps,
  provider: IPtyProvider,
  occupant: CodexRestartOccupant
): Promise<boolean> {
  const findHolders = resolveTranscriptHolderLookup(deps)
  if (!findHolders) {
    return false
  }
  try {
    const processes = await provider.listProcesses({
      ptyIds: [occupant.ptyId],
      targetOwnerOnly: true
    })
    const owner = processes.find(
      (process) => process.id === occupant.ptyId && process.incarnationId === occupant.incarnationId
    )
    if (!owner?.rootProcessId || owner.exiting) {
      return false
    }
    const holders = await findHolders(occupant.provenance.transcriptPath)
    if (!holders?.length) {
      return false
    }
    const snapshot = await (deps.captureDescendants ?? captureDescendantSnapshot)(
      owner.rootProcessId
    )
    if (!snapshot?.root) {
      return false
    }
    const owned = new Set([snapshot.root.pid, ...snapshot.descendants.map((row) => row.pid)])
    return holders.every((pid) => owned.has(pid))
  } catch {
    return false
  }
}

const HOLDER_CHECK_TIMEOUT_MS = 5_000

/** Codex keeps the rollout open for its session. Null means the holder check could not finish. */
export async function listCodexTranscriptHolders(
  transcriptPath: string,
  deps: TranscriptWriterCheckDeps = defaultDeps
): Promise<readonly number[] | null> {
  try {
    if (deps.platform === 'darwin') {
      // Absolute: a GUI app's stripped PATH may not reach /usr/sbin.
      return await listLsofHolders(deps.exec, '/usr/sbin/lsof', transcriptPath)
    }
    return deps.platform === 'linux' ? await deps.findProcHolders(transcriptPath) : null
  } catch {
    return null
  }
}

async function listLsofHolders(
  exec: Exec,
  program: string,
  transcriptPath: string
): Promise<readonly number[] | null> {
  const result = await exec(program, ['-t', '--', transcriptPath])
  if (result.stderr.trim() !== '') {
    return null
  }
  const output = result.stdout.trim()
  // Exit 1 with no output or diagnostics means lsof found no matching inode.
  if (result.code === 1 && output === '') {
    return []
  }
  return result.code === 0 && /^\d+(?:\n\d+)*$/.test(output) ? output.split('\n').map(Number) : null
}

const defaultDeps: TranscriptWriterCheckDeps = {
  platform: process.platform,
  exec: async (program, args) => {
    const result = await runProcess({ program, args, timeoutMs: HOLDER_CHECK_TIMEOUT_MS })
    return {
      code: result.timedOut ? null : result.code,
      stdout: result.stdout,
      stderr: result.stderr
    }
  },
  findProcHolders: readProcTranscriptHolders
}

async function readProcTranscriptHolders(target: string): Promise<number[] | null> {
  const { uid } = await stat('/proc/self')
  const { dev, ino } = await stat(target, { bigint: true })
  const deadline = performance.now() + HOLDER_CHECK_TIMEOUT_MS
  const pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  const holders: number[] = []
  for (const pid of pids) {
    if (performance.now() >= deadline) {
      return null
    }
    const processDir = join('/proc', pid)
    let fds: string[]
    try {
      if ((await stat(processDir)).uid !== uid) {
        continue
      }
      fds = await readdir(join(processDir, 'fd'))
    } catch (error) {
      // A process that exits while we enumerate /proc has no open descriptors left.
      if (!(await procEntryNoLongerRelevant(error, processDir, uid))) {
        return null
      }
      continue
    }
    for (const fd of fds) {
      if (performance.now() >= deadline) {
        return null
      }
      try {
        const descriptor = await stat(join(processDir, 'fd', fd), { bigint: true })
        if (descriptor.dev === dev && descriptor.ino === ino) {
          holders.push(Number(pid))
          break
        }
      } catch (error) {
        if (!(await procEntryNoLongerRelevant(error, processDir, uid))) {
          return null
        }
      }
    }
  }
  return holders
}

async function procEntryNoLongerRelevant(error: unknown, processDir: string, uid: number) {
  if (isMissingProcEntry(error)) {
    return true
  }
  // The process may have exited or changed credentials after the first ownership read.
  try {
    return (await stat(processDir)).uid !== uid
  } catch (inspectError) {
    return isMissingProcEntry(inspectError)
  }
}

function isMissingProcEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH')
  )
}
