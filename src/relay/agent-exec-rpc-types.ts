import type { ChildProcess } from 'child_process'

export type ExecParams = {
  binary: unknown
  args: unknown
  cwd: unknown
  stdin: unknown
  timeoutMs: unknown
  env: unknown
  operation: unknown
  shell: unknown
}

export type CancelParams = {
  cwd: unknown
  operation: unknown
}

export type InFlightExec = { child: ChildProcess; cancel: () => void }

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when the user canceled the exec via `agent.cancelExec`. */
  canceled?: boolean
  /** Set when the binary could not be spawned (e.g. ENOENT). */
  spawnError?: string
}
