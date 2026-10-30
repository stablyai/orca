/**
 * How a run ended, for a window that only follows its progress (it reloaded mid-move, or the move
 * started elsewhere). A committed run says so with `done`; without this, any other end left that
 * window's dialog on its last step until a reload.
 */
import type {
  WslMoveProgressStep,
  WslMoveResult
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'

export async function reportWslMoveRunEnd(
  deps: WslMoveDriverDeps,
  distro: string,
  run: (tracked: WslMoveDriverDeps) => Promise<WslMoveResult>
): Promise<WslMoveResult> {
  let lastStep: WslMoveProgressStep = 'preparing'
  const result = await run({
    ...deps,
    progress: (event) => {
      lastStep = event.step
      deps.progress(event)
    }
  })
  if (result.outcome !== 'moved') {
    deps.progress({ distro, step: lastStep, result })
  }
  return result
}
