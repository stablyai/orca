import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../codex/codex-app-server-posix-supervisor'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
// A signalled supervisor escalates on its own; forcing it sooner kills it and orphans Claude.
export const SUPERVISED_GRACEFUL_EXIT_MS = PROVIDER_SUPERVISOR_MAX_STOP_MS + 500
const FORCED_EXIT_MS = 1_000

export type ClaudeChildExitProofInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
  /** The child is the POSIX provider supervisor: SIGTERM stops Claude, which reaps its tools. */
  supervised?: boolean
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  const tree = input.tree ?? createTree()
  // Arm before the stop: only a live root can identify its descendants.
  await tree.capture()
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  // Stdin end alone lets Claude finish its turn, tools and edits included; a close is a stop.
  // Windows has no supervisor, and a direct SIGTERM there is TerminateProcess.
  if (input.supervised && !input.exited()) {
    input.child.kill('SIGTERM')
  }
  let reaped = false
  if (!input.exited()) {
    await waitForProcessExitUntil(
      input.exitPromise,
      input.supervised ? SUPERVISED_GRACEFUL_EXIT_MS : GRACEFUL_EXIT_MS
    )
    if (!input.exited()) {
      reaped = true
      await tree.refresh?.()
      await tree.reap()
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    }
  }
  if (!reaped && input.exited() && tree.treeVerdict !== 'exited') {
    await tree.reap()
  }
  return input.exited() && tree.treeVerdict === 'exited'
}
