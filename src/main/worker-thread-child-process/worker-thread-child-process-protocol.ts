/** Structured-clone-safe subset of ProcessSpec; stdio is always three pipes. */
export type WorkerThreadChildSpec = {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  terminationBarrier?: true
}

export type WorkerThreadProviderOwnerSpec = {
  nonce: string
  path: string
  program: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type WorkerThreadChildRequest =
  | { type: 'spawn'; id: number; spec: WorkerThreadChildSpec }
  | { type: 'spawn-provider-owner'; id: number; spec: WorkerThreadProviderOwnerSpec }
  | { type: 'stdin-write'; id: number; data: string | Uint8Array }
  | { type: 'stdin-end'; id: number }
  | { type: 'output-consumed'; id: number; bytes: number }
  | { type: 'stop-owned-group'; id: number }
  // Sent only for a close marked 'retained'.
  | { type: 'release'; id: number }
  | { type: 'kill'; id: number; signal?: NodeJS.Signals }
  // Drops a spawn still queued behind other launches; ignored once the process exists.
  | { type: 'cancel-spawn'; id: number }
  // The reader stopped; the worker drains the pipes itself instead of forwarding them.
  | { type: 'discard-output'; id: number; stream?: 'stdout' | 'stderr' }

/** Node's errno fields survive the hop so callers can classify spawn failures (spawn ENOENT). */
export type WorkerThreadChildErrorPayload = {
  message: string
  code?: string
  errno?: number
  syscall?: string
  path?: string
}

export type WorkerThreadChildEvent =
  // Posted once the server listens, before it handles any request: a worker lost before it ran nothing.
  | { type: 'ready' }
  // Posted in the same turn the process is created, so a worker lost after that still reported the pid.
  | { type: 'spawn'; id: number; pid: number | undefined }
  | { type: 'group-terminated'; id: number }
  // Emitted when a worker-owned group stop finishes without proving every member exited.
  | { type: 'group-stop-unverified'; id: number }
  // Structured clone turns a Buffer into a plain Uint8Array.
  | { type: 'stdout' | 'stderr'; id: number; chunk: Uint8Array }
  // 'spawn-error': process creation threw, so no exit or close will follow.
  | { type: 'error' | 'spawn-error'; id: number; error: WorkerThreadChildErrorPayload }
  | { type: 'exit'; id: number; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'provider-owner-spawned'; id: number; pid: number }
  | { type: 'provider-owner-exit'; id: number }
  | { type: 'provider-owner-error'; id: number; error: WorkerThreadChildErrorPayload }
  // 'retained': the worker still tracks the child (an owned POSIX group) until main sends 'release'.
  | {
      type: 'close'
      id: number
      code: number | null
      signal: NodeJS.Signals | null
      retained?: true
    }
