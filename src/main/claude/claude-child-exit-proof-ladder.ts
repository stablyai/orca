import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

export type ClaudeChildExitProofInput = {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  const tree = input.tree ?? createTree()
  // Arm before stdin closes: only a live root can identify its descendants.
  await tree.capture()
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  let reaped = false
  if (!input.exited()) {
    await waitForProcessExitUntil(input.exitPromise, GRACEFUL_EXIT_MS)
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
