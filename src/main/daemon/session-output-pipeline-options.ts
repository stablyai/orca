import type { SessionOptions } from './session-options'
import type { SubprocessHandle } from './session-subprocess-handle'
import { createSessionOutputPipeline } from './session-output-pipeline'

export function createSessionOutput(
  opts: SessionOptions,
  incarnationId: string,
  subprocess: SubprocessHandle,
  isAlive: () => boolean
): ReturnType<typeof createSessionOutputPipeline> {
  return createSessionOutputPipeline({
    incarnationId,
    startupCommand: opts.startupCommand,
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    ownerBackend: opts.ownerBackend,
    subprocess,
    isAlive
  })
}
