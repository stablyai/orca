import type { OrcaRuntimeService } from '../orca-runtime'
import type { TerminalInputArrivalTarget } from '../terminal-input-arrival'

export function captureTerminalInputArrivalTestTarget(
  this: OrcaRuntimeService,
  handle: string
): TerminalInputArrivalTarget {
  const resolve = (): string =>
    this.resolveLiveLeafForHandle?.(handle)?.ptyId ??
    this.resolveLeafForHandle?.(handle)?.ptyId ??
    'pty-1'
  const ptyId = resolve()
  return {
    ptyId,
    generation: 1,
    assertCurrent: () => {
      if (resolve() !== ptyId) {
        throw new Error('terminal_handle_stale')
      }
    }
  }
}
