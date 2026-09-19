import { parentPort } from 'node:worker_threads'
import { scanClaudeUsageFiles } from '../claude-usage/scanner'
import { scanCodexUsageFiles } from '../codex-usage/scanner'
import { scanOpenCodeUsageDatabases } from '../opencode-usage/scanner'
import type {
  UsageScanWorkerProgress,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse,
  UsageScanWorkerValue
} from './usage-scan-worker-protocol'

// Why (#20940): the Claude/Codex/OpenCode usage scans parse whole history
// corpora and read SQLite synchronously. Running them on this worker thread
// keeps that work off the Electron main-process event loop. The client
// dispatches one request at a time, so this loop stays serial; imports must
// remain electron-free (see the worker-protocol note) — the build's
// plain-node-entry-guard enforces it for this entry.
//
// Child processes: this bundle can fork one. OpenCode discovery's `wslGated*`
// calls fork the WSL transcript sidecar whenever the path is a `\\wsl$\...`
// UNC one, which a `OPENCODE_DB` or `XDG_DATA_HOME` override can be. Measured
// through this entry: the sidecar is reaped by `worker.terminate()`, because
// tearing the thread down closes the IPC channel it owned and the sidecar
// entry exits on `disconnect`. That is the only reason it is not an orphan —
// `terminate()` itself reaps nothing. A future spawn from here that does not
// exit when its channel closes would outlive the app's use of it, so give any
// such child an owner that kills it explicitly. Codex needs no gate (pure
// `areWorktreePathsEqual`). Note the sidecar is re-forked per worker
// lifecycle rather than pooled for the app's life, as it was pre-worker.

if (!parentPort) {
  throw new Error('Usage scan worker must run with a parent port.')
}
const port = parentPort

// Why: the client's deadline is a no-progress window, so a scan that is slow
// because the corpus is large has to say so. Rate-limited because a 21k-file
// corpus would otherwise wake the main thread 21k times for a counter it only
// reads as "still moving".
const PROGRESS_POST_INTERVAL_MS = 1_000

function createProgressReporter(id: number): (count: number) => void {
  let filesScanned = 0
  let lastPostedAt = 0
  return (count) => {
    filesScanned += count
    const now = Date.now()
    if (now - lastPostedAt < PROGRESS_POST_INTERVAL_MS) {
      return
    }
    lastPostedAt = now
    const progress: UsageScanWorkerProgress = { id, filesScanned }
    port.postMessage(progress)
  }
}

async function runScan(
  request: UsageScanWorkerRequest,
  onFilesScanned: (count: number) => void
): Promise<UsageScanWorkerValue> {
  // Switched, not table-driven: each branch narrows `previous` to that
  // provider's own record type, so nothing here needs a type assertion.
  switch (request.providerId) {
    case 'claude': {
      const result = await scanClaudeUsageFiles(
        request.worktrees,
        request.previous,
        request.target,
        onFilesScanned
      )
      return {
        providerId: 'claude',
        source: result.processedFiles,
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
    case 'codex': {
      const result = await scanCodexUsageFiles(request.worktrees, request.previous, onFilesScanned)
      return {
        providerId: 'codex',
        source: result.processedFiles,
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
    case 'opencode': {
      const result = await scanOpenCodeUsageDatabases(
        request.worktrees,
        request.previous,
        onFilesScanned
      )
      return {
        providerId: 'opencode',
        source: result.processedDatabases,
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
  }
}

async function handleRequest(request: UsageScanWorkerRequest): Promise<UsageScanWorkerResponse> {
  try {
    return {
      id: request.id,
      ok: true,
      value: await runScan(request, createProgressReporter(request.id))
    }
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

port.on('message', (request: UsageScanWorkerRequest) => {
  void handleRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // A non-cloneable result would otherwise post nothing and leave the client
      // waiting out its timeout; fail that request fast instead.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Usage scan worker result could not be serialized.'
      })
    }
  })
})
