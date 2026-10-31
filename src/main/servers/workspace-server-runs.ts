import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import type {
  WorkspaceServerInfo,
  WorkspaceServerLogLine,
  WorkspaceServerSnapshot
} from '../../shared/workspace-server-process'

export type WorkspaceServerRun = {
  info: Omit<WorkspaceServerInfo, 'active'>
  child: PipedChildProcess | null
  logs: WorkspaceServerLogLine[]
  pending: WorkspaceServerLogLine[]
  timer?: ReturnType<typeof setTimeout>
  stopped: boolean
  done: Promise<void>
  finish: () => void
  stopPromise?: Promise<WorkspaceServerSnapshot>
}
export const isWorkspaceServerActive = (run: WorkspaceServerRun) =>
  run.child !== null || ['starting', 'running', 'stopping'].includes(run.info.status)

export function retireInactiveServerRun(runs: Map<string, WorkspaceServerRun>): WorkspaceServerRun {
  const retired = [...runs.entries()]
    .filter(([, run]) => !isWorkspaceServerActive(run) && !run.stopPromise)
    .sort(([, a], [, b]) => a.info.startedAt - b.info.startedAt)[0]
  if (!retired) {
    throw new Error('Too many managed servers.')
  }
  const [key, run] = retired
  clearTimeout(run.timer)
  run.pending = []
  runs.delete(key)
  return run
}

export async function stopServerRuns(
  runs: Iterable<WorkspaceServerRun>,
  matches: (run: WorkspaceServerRun) => boolean,
  stop: (worktreeId: string, port: number, runId: string) => Promise<WorkspaceServerSnapshot>
): Promise<void> {
  const results = await Promise.allSettled(
    [...runs]
      .filter((run) => matches(run) && (isWorkspaceServerActive(run) || run.stopPromise))
      .map((run) => stop(run.info.worktreeId, run.info.port, run.info.id))
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') {
    throw failed.reason
  }
}

export async function forceCloseServerRuns(runs: Iterable<WorkspaceServerRun>): Promise<void> {
  const results = await Promise.allSettled(
    [...runs].map(async (run) => {
      if (!run.child) {
        return
      }
      run.stopped = true
      if (!(await forceTerminateProcessTree(run.child))) {
        throw new Error('Could not verify server termination.')
      }
    })
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') {
    throw failed.reason
  }
}
