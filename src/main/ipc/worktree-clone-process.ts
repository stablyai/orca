import {
  runProcess,
  type ProcessSpec,
  type ProcessResult
} from '../../shared/child-process/run-process'
import { WorktreeCloneInterruptedError } from './worktree-clone-copy-errors'

export async function runWorktreeCloneProcess(
  spec: Pick<ProcessSpec, 'program' | 'args' | 'timeoutMs'>,
  run: typeof runProcess = runProcess
): Promise<ProcessResult> {
  let terminated = false
  try {
    const result = await run({
      ...spec,
      timeoutMs: spec.timeoutMs ?? 120_000,
      maxOutputBytes: 16 * 1024,
      detached: true,
      terminationBarrier: true,
      onChildTerminated: () => {
        terminated = true
      }
    })
    if (!terminated || result.timedOut) {
      throw new WorktreeCloneInterruptedError(terminated ? 'exited' : 'unverifiable')
    }
    return result
  } catch (error) {
    if (!terminated) {
      throw new WorktreeCloneInterruptedError('unverifiable')
    }
    throw error
  }
}
