import { runProcess } from '../shared/child-process/run-process'

export const MAX_GIT_BUFFER = 10 * 1024 * 1024
const GIT_REBASE_PROCESS_FALLBACK_TIMEOUT_MS = 2_147_000_000

type GitTerminationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

export async function runGitToTermination(
  args: string[],
  options: GitTerminationOptions,
  stdin: string | undefined
): Promise<{ stdout: string; stderr: string }> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    timeoutMs:
      typeof options.timeout === 'number'
        ? options.timeout
        : GIT_REBASE_PROCESS_FALLBACK_TIMEOUT_MS,
    maxOutputBytes: typeof options.maxBuffer === 'number' ? options.maxBuffer : MAX_GIT_BUFFER,
    signal: options.signal,
    terminationBarrier: true,
    ...(stdin === undefined ? {} : { input: stdin })
  })
  if (result.code === 0 && !result.timedOut && !options.signal?.aborted) {
    return { stdout: result.stdout, stderr: result.stderr }
  }
  const error = new Error(
    result.timedOut
      ? `git ${args[0] ?? 'command'} timed out.`
      : options.signal?.aborted
        ? 'The operation was aborted.'
        : result.stderr.trim() || `git ${args[0] ?? 'command'} failed.`
  )
  if (options.signal?.aborted) {
    error.name = 'AbortError'
  }
  throw Object.assign(error, {
    code: result.code,
    killed: result.timedOut || result.signal !== null || options.signal?.aborted === true,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr
  })
}
