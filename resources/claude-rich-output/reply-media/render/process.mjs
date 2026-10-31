import { runProcessSync } from '@orca/process-host'

export function runRendererProcess(program, args, options = {}) {
  const { encoding: _encoding, input, ...rest } = options
  const result = runProcessSync({ program, args, input, timeoutMs: 120_000, ...rest })
  return {
    status: result.code,
    stdout: result.stdout,
    stderr:
      result.stderr ||
      (result.timedOut ? `${program} timed out` : '') ||
      (result.code === 0 ? '' : `${program} exited with status ${result.code ?? result.signal}`)
  }
}
