import type { Serializable } from 'node:child_process'

/** Structured-clone-safe subset of ProcessSpec; stdio is always three pipes. */
export type WorkerThreadChildSpec = {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export type WorkerThreadForkSpec = {
  modulePath: string
  args: string[]
  env: Record<string, string | undefined>
  execArgv: string[]
}

export type WorkerThreadChildRequest =
  | { type: 'spawn'; id: number; spec: WorkerThreadChildSpec }
  | { type: 'fork'; id: number; spec: WorkerThreadForkSpec }
  | { type: 'ipc-send'; id: number; sendId: number; message: Serializable }
  | { type: 'stdin-write'; id: number; data: string }
  | { type: 'stdin-end'; id: number }
  | { type: 'output-consumed'; id: number; bytes: number }
  | { type: 'kill'; id: number; signal?: NodeJS.Signals }

export type WorkerThreadChildErrorPayload = { message: string; code?: string }

export type WorkerThreadChildEvent =
  | { type: 'spawn'; id: number; pid: number | undefined }
  | { type: 'ipc-message'; id: number; message: unknown }
  | { type: 'ipc-sent'; id: number; sendId: number; error?: WorkerThreadChildErrorPayload }
  | { type: 'disconnect'; id: number }
  // Structured clone turns a Buffer into a plain Uint8Array.
  | { type: 'stdout' | 'stderr'; id: number; chunk: Uint8Array }
  // 'spawn-error': process creation threw, so no exit or close will follow.
  | { type: 'error' | 'spawn-error'; id: number; error: WorkerThreadChildErrorPayload }
  | { type: 'exit' | 'close'; id: number; code: number | null; signal: NodeJS.Signals | null }
