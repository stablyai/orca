import { commitAttachedPtySize } from '../delivery/attached-pty-size'
import type { RuntimePtySpawnState } from './spawn-state'

/** Record the settled grid for a runtime-path spawn; `result` is passed explicitly because the
 *  adopted-claim branch commits before it returns early. */
export function commitRuntimePtySize(
  ctx: RuntimePtySpawnState,
  result: RuntimePtySpawnState['result']
): void {
  commitAttachedPtySize({
    result,
    requested: { cols: ctx.args.cols, rows: ctx.args.rows },
    cachedBeforeAttach: ctx.sessionSizeBeforeAttach,
    reflowHeadlessTerminalToPtyGrid: ctx.deps.runtime?.reflowHeadlessTerminalToPtyGrid?.bind(
      ctx.deps.runtime
    )
  })
}
