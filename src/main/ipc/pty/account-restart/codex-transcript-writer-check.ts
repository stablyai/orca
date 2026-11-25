import { runProcess } from '@orca/process-host'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { captureDescendantSnapshot } from '../../../pty/process-retirement/pty-descendant-termination'
import type { CodexRestartOccupant } from './codex-account-restart-types'

type ExecResult = { code: number | null; stdout: string; stderr: string }
type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

export type CodexTranscriptWriterDeps = {
  /** Null means the host cannot verify who holds the transcript open. */
  listTranscriptHolders?: ((transcriptPath: string) => Promise<readonly number[] | null>) | null
  captureDescendants?: typeof captureDescendantSnapshot
}

export function resolveTranscriptHolderLookup(
  deps: CodexTranscriptWriterDeps,
  platform: NodeJS.Platform = process.platform
) {
  if (deps.listTranscriptHolders !== undefined) {
    return deps.listTranscriptHolders
  }
  // Linux procfs can withhold descriptors even for same-user processes.
  return platform === 'darwin' ? listCodexTranscriptHolders : null
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
  exec: Exec = runLsof
): Promise<readonly number[] | null> {
  try {
    // A GUI app's stripped PATH may not reach /usr/sbin.
    return await listLsofHolders(exec, '/usr/sbin/lsof', transcriptPath)
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

async function runLsof(program: string, args: readonly string[]): Promise<ExecResult> {
  const result = await runProcess({ program, args, timeoutMs: HOLDER_CHECK_TIMEOUT_MS })
  return {
    code: result.timedOut ? null : result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }
}
