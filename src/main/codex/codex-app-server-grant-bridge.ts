import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * Blocking wrapper for the grant session. Hook install/refresh is synchronous
 * launch prep (pane launch must not proceed until trust is settled), and a
 * stdio JSON-RPC session needs a live event loop — so the session runs in a
 * short-lived ELECTRON_RUN_AS_NODE child (same pattern as the daemon and
 * parcel-watcher entries) while the caller blocks on spawnSync. spawnSync
 * always reaps the entry; a killed entry closes the codex child's stdin,
 * which makes codex app-server exit on EOF.
 */
export function runCodexHookTrustGrantSessionSync(
  request: CodexHookTrustGrantRequest,
  options: RunGrantSessionSyncOptions = {}
): CodexHookTrustGrantSessionResult {
  return runCodexAppServerEntrySync(request, options) as CodexHookTrustGrantSessionResult
}

export function runCodexUserHookTrustRebaseSessionSync(
  request: CodexUserHookTrustRebaseRequest,
  options: RunGrantSessionSyncOptions = {}
): CodexUserHookTrustRebaseResult {
  return runCodexAppServerEntrySync(request, options) as CodexUserHookTrustRebaseResult
}

function runCodexAppServerEntrySync(
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
