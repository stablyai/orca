/** Structured-clone-safe subset of ProcessSpec; stdio is always three pipes. */
export type WorkerThreadChildSpec = {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  terminationBarrier?: true
}

export type WorkerThreadChildRequest =
  | { type: 'spawn'; id: number; spec: WorkerThreadChildSpec }
  | { type: 'stdin-write'; id: number; data: string }
  | { type: 'stdin-end'; id: number }
  | { type: 'output-consumed'; id: number; bytes: number }
  | { type: 'stop-owned-group'; id: number }
  | { type: 'release'; id: number }
  | { type: 'kill'; id: number; signal?: NodeJS.Signals }
  // Drops a spawn still queued behind other launches; ignored once the process exists.
  | { type: 'cancel-spawn'; id: number }
  // The reader stopped; the worker drains the pipes itself instead of forwarding them.
  | { type: 'discard-output'; id: number }

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
  | { type: 'spawn'; id: number; pid: number | undefined }
  | { type: 'group-terminated'; id: number }
  // Structured clone turns a Buffer into a plain Uint8Array.
  | { type: 'stdout' | 'stderr'; id: number; chunk: Uint8Array }
  // 'spawn-error': process creation threw, so no exit or close will follow.
  | { type: 'error' | 'spawn-error'; id: number; error: WorkerThreadChildErrorPayload }
  | { type: 'exit' | 'close'; id: number; code: number | null; signal: NodeJS.Signals | null }
