import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions as NodeSpawnOptions,
  StdioOptions
} from 'node:child_process'

export type ChildProcessHandle = ChildProcess

export type SpawnedProcess = ChildProcess

/** Centralizes host execution settings so argument encoding and tree ownership stay consistent. */
export type ProcessSpec = {
  /**
   * Program to run. On Windows this should already be an absolute path —
   * spawning by bare name depends on the child's PATH, which under Group Policy
   * or a stripped Electron environment can resolve to nothing.
   */
  program: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the process (and, on Windows, its console) after this long. */
  timeoutMs?: number | null
  /** Written to stdin then closed. Omit to leave stdin empty and closed. */
  input?: string
  /** Cap on captured stdout/stderr; output past it is discarded. */
  maxOutputBytes?: number
  /** Capture stdout as bytes without decoding; stdout stays empty in this mode. */
  captureStdoutAsBytes?: boolean
  /** Stop a parser command as soon as captured output exceeds its cap. */
  killOnOutputLimit?: boolean
  /** Kills the process when aborted; the result still reports the exit. */
  signal?: AbortSignal
  /** Keep the child in its own POSIX process group for tree termination. */
  detached?: boolean
  /** Preserve a caller-owned Windows command line such as a cmd.exe invocation. */
  windowsVerbatimArguments?: boolean
  /** Streaming callers may suppress child output for auxiliary processes. */
  stdio?: NodeSpawnOptions['stdio']
  /** Bun and Node require JSON for an IPC channel shared between the two runtimes. */
  serialization?: NodeSpawnOptions['serialization']
  /** Await tree termination or observed root exit, then settle at the final deadline if unverified. */
  terminationBarrier?: boolean | ProcessTerminationBarrier
  /** Called once when the child exits or tree termination is verified. */
  onChildTerminated?: () => void
}

export type PipedChildProcess = ChildProcessWithoutNullStreams

export type PipedProcessSpec = Omit<ProcessSpec, 'stdio'> & {
  stdio?: 'pipe' | ['pipe', 'pipe', 'pipe', ...Exclude<StdioOptions, string>]
}

export type PipedProcessSpawner = (spec: PipedProcessSpec) => PipedChildProcess

export type ProcessTerminationBarrier = {
  observeStderr?: (chunk: Buffer | string) => void
  signal: (child: ChildProcess, signal?: NodeJS.Signals) => Promise<boolean>
  force: (child: ChildProcess) => Promise<boolean>
}

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stdoutBytes?: Buffer
  stderr: string
  /** True when the process was killed by `timeoutMs` rather than exiting. */
  timedOut: boolean
  /** True when stdout or stderr exceeded `maxOutputBytes` and was clipped. */
  outputTruncated?: boolean
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
