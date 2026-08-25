import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import type {
  CodexAppServerEntryRequest,
  CodexAppServerEntryResult,
  GrantEntryEnvelope
} from './codex-app-server-grant-envelope'
import type {
  CodexUserHookTrustRebaseRequest,
  CodexUserHookTrustRebaseResult
} from './codex-user-hook-trust-rebase-client'

// Why: hook install/refresh is synchronous launch prep — a Codex pane must
// not start before its trust is settled — but a stdio JSON-RPC session needs
// a live event loop. This bridge blocks the caller on spawnSync of a bundled
// ELECTRON_RUN_AS_NODE entry (same pattern as the daemon and parcel-watcher
// entries) that runs the session and reports one JSON envelope on stdout.

const GRANT_ENTRY_FILE_NAME = 'codex-app-server-grant-entry.js'
// Why: spawnSync must outlive the session deadline so the entry's own timeout
// (and its result envelope) win the race; the margin only reaps a hung entry.
const GRANT_ENTRY_TIMEOUT_MARGIN_MS = 5_000
const GRANT_ENTRY_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const GRANT_WORKER_TIMEOUT_MARGIN_MS = 2_000
const GRANT_WORKER_FILE_NAME = 'codex-app-server-grant-worker-entry.js'

export function resolveCodexGrantEntryPath(
  pathExists: (candidate: string) => boolean = existsSync,
  moduleDir = __dirname
): string | null {
  // Why: resolved from __dirname (not electron's app paths) so this module
  // stays loadable in plain-node CLI entries — the build guard rejects any
  // electron require reachable from them. The emitted bridge chunk sits in
  // out/main or out/main/chunks, so the entry is one or two levels up.
  // ELECTRON_RUN_AS_NODE bypasses asar integration, so packaged builds must
  // run the copy under app.asar.unpacked (out/main/codex/** is asarUnpacked).
  const toUnpackedDir = (dir: string): string =>
    dir.replace(/([\\/])app\.asar(?=([\\/]|$))/, '$1app.asar.unpacked')
  const baseDirs = [moduleDir, join(moduleDir, '..')].map(toUnpackedDir)
  for (const baseDir of baseDirs) {
    const candidate = join(baseDir, 'codex', GRANT_ENTRY_FILE_NAME)
    if (pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

export type RunGrantSessionSyncOptions = {
  entryPath?: string
  nodeCommand?: string
  /** Test-only override; production keeps enough margin for child cleanup. */
  timeoutMarginMs?: number
}

export type RunGrantSessionOptions = RunGrantSessionSyncOptions & {
  workerPath?: string
  workerFactory?: (workerPath: string, workerData: CodexGrantWorkerRequest) => Worker
}

export type CodexGrantWorkerRequest = {
  request: CodexAppServerEntryRequest
  options: RunGrantSessionSyncOptions
}

type CodexGrantWorkerResponse =
  | { ok: true; result: CodexAppServerEntryResult }
  | { ok: false; errorName: string; message: string; unsupported?: boolean }

export function resolveCodexGrantWorkerPath(
  pathExists: (candidate: string) => boolean = existsSync,
  moduleDir = __dirname
): string | null {
  const toUnpackedDir = (dir: string): string =>
    dir.replace(/([\\/])app\.asar(?=([\\/]|$))/, '$1app.asar.unpacked')
  const baseDirs = [moduleDir, join(moduleDir, '..')].map(toUnpackedDir)
  for (const baseDir of baseDirs) {
    const candidate = join(baseDir, 'codex', GRANT_WORKER_FILE_NAME)
    if (pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Blocking wrapper for the grant session. Hook install/refresh is synchronous
 * launch prep (pane launch must not proceed until trust is settled), and a
 * stdio JSON-RPC session needs a live event loop — so the session runs in a
 * short-lived ELECTRON_RUN_AS_NODE child (same pattern as the daemon and
 * parcel-watcher entries) while the caller blocks on spawnSync. spawnSync
 * always reaps the entry; a killed entry closes the codex child's stdin,
 * which makes codex app-server exit on EOF.
 */
export function runCodexHookTrustGrantSession(
  request: CodexHookTrustGrantRequest,
  options: RunGrantSessionOptions = {}
): Promise<CodexHookTrustGrantSessionResult> {
  return runCodexAppServerEntryInWorker(
    request,
    options
  ) as Promise<CodexHookTrustGrantSessionResult>
}

export function runCodexHookTrustGrantSessionSync(
  request: CodexHookTrustGrantRequest,
  options: RunGrantSessionSyncOptions = {}
): CodexHookTrustGrantSessionResult {
  return runCodexAppServerEntrySync(request, options) as CodexHookTrustGrantSessionResult
}

export function runCodexUserHookTrustRebaseSession(
  request: CodexUserHookTrustRebaseRequest,
  options: RunGrantSessionOptions = {}
): Promise<CodexUserHookTrustRebaseResult> {
  return runCodexAppServerEntryInWorker(request, options) as Promise<CodexUserHookTrustRebaseResult>
}

export function runCodexUserHookTrustRebaseSessionSync(
  request: CodexUserHookTrustRebaseRequest,
  options: RunGrantSessionSyncOptions = {}
): CodexUserHookTrustRebaseResult {
  return runCodexAppServerEntrySync(request, options) as CodexUserHookTrustRebaseResult
}

export function runCodexAppServerEntrySync(
  request: CodexAppServerEntryRequest,
  options: RunGrantSessionSyncOptions
): CodexAppServerEntryResult {
  const entryPath = options.entryPath ?? resolveCodexGrantEntryPath()
  if (!entryPath) {
    throw new Error('codex trust-grant entry bundle not found')
  }
  const spawned = spawnSync(options.nodeCommand ?? process.execPath, [entryPath], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout:
      request.invocation.timeoutMs + (options.timeoutMarginMs ?? GRANT_ENTRY_TIMEOUT_MARGIN_MS),
    killSignal: 'SIGKILL',
    maxBuffer: GRANT_ENTRY_MAX_BUFFER_BYTES,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if ((spawned.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    // Why: spawnSync reports its own deadline through error.code before the
    // signal field; preserve the typed timeout so cooldown diagnostics work.
    throw new CodexAppServerTimeoutError(
      `codex trust-grant entry exceeded ${request.invocation.timeoutMs}ms session deadline`
    )
  }
  if (spawned.error) {
    throw spawned.error
  }
  if (spawned.signal) {
    throw new CodexAppServerTimeoutError(
      `codex trust-grant entry killed by ${spawned.signal} after ${request.invocation.timeoutMs}ms deadline`
    )
  }
  const lines = (spawned.stdout ?? '').split('\n').filter((line) => line.trim().length > 0)
  const lastLine = lines.at(-1)
  let envelope: GrantEntryEnvelope | null = null
  if (lastLine) {
    try {
      envelope = JSON.parse(lastLine) as GrantEntryEnvelope
    } catch {
      envelope = null
    }
  }
  if (!envelope) {
    throw new Error(
      `codex trust-grant entry produced no result (exit ${spawned.status ?? 'unknown'})${
        spawned.stderr ? `: ${spawned.stderr.trim().slice(0, 400)}` : ''
      }`
    )
  }
  if (!envelope.ok) {
    if (envelope.unsupported) {
      throw new CodexAppServerUnsupportedError(envelope.message)
    }
    if (envelope.errorName === 'CodexAppServerTimeoutError') {
      throw new CodexAppServerTimeoutError(envelope.message)
    }
    throw new Error(envelope.message)
  }
  return envelope.result
}

function runCodexAppServerEntryInWorker(
  request: CodexAppServerEntryRequest,
  options: RunGrantSessionOptions
): Promise<CodexAppServerEntryResult> {
  const workerPath = options.workerPath ?? resolveCodexGrantWorkerPath()
  if (!workerPath) {
    return Promise.reject(new Error('codex trust-grant worker bundle not found'))
  }
  const workerData: CodexGrantWorkerRequest = {
    request,
    options: {
      entryPath: options.entryPath,
      nodeCommand: options.nodeCommand,
      timeoutMarginMs: options.timeoutMarginMs
    }
  }
  let worker: Worker
  try {
    worker = (options.workerFactory ?? ((path, data) => new Worker(path, { workerData: data })))(
      workerPath,
      workerData
    )
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const deadlineMs =
      request.invocation.timeoutMs +
      (options.timeoutMarginMs ?? GRANT_ENTRY_TIMEOUT_MARGIN_MS) +
      GRANT_WORKER_TIMEOUT_MARGIN_MS
    const deadline = setTimeout(() => {
      finish(() =>
        reject(
          new CodexAppServerTimeoutError(
            `codex trust-grant worker exceeded ${request.invocation.timeoutMs}ms session deadline`
          )
        )
      )
    }, deadlineMs)
    deadline.unref?.()

    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      worker.removeAllListeners()
      void worker.terminate().catch(() => undefined)
      settle()
    }

    worker.once('message', (response: CodexGrantWorkerResponse) => {
      finish(() => {
        if (response.ok) {
          resolve(response.result)
          return
        }
        if (response.unsupported) {
          reject(new CodexAppServerUnsupportedError(response.message))
          return
        }
        if (response.errorName === 'CodexAppServerTimeoutError') {
          reject(new CodexAppServerTimeoutError(response.message))
          return
        }
        const error = new Error(response.message)
        error.name = response.errorName
        reject(error)
      })
    })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => {
      if (!settled) {
        finish(() => reject(new Error(`codex trust-grant worker exited with code ${code}`)))
      }
    })
  })
}
