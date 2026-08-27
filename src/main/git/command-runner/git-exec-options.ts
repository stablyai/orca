// Why: cap execFile output to prevent an uncatchable V8 string overflow; match relay MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

export type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  wslDistro?: string
  preferWslDirectGit?: boolean
  useConfiguredSshCommandForNetwork?: boolean
  terminationBarrier?: boolean
  captureWslLoginShellOutput?: boolean
}
