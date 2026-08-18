import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Plugin, Rollup } from 'vite'

type NormalizedInputOptions = Rollup.NormalizedInputOptions
type NormalizedOutputOptions = Rollup.NormalizedOutputOptions
type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk

// Why: v1.4.129-rc.1 shipped a dead terminal daemon because a shared main
// chunk gained `require("electron")` (an import edge added in #7642), and the
// daemon is forked as a plain-Node process where electron cannot be required.
// Nothing in CI executes the built daemon-entry under plain Node, so the leak
// stayed invisible until an adopted old daemon died. This guard fails the
// build when any chunk reachable from a plain-Node fork entry requires
// electron, and smoke-loads daemon-entry under plain Node to prove its module
// graph still resolves.

// Entries executed as plain Node (ELECTRON_RUN_AS_NODE / no electron runtime):
// forked daemon, parcel-watcher, WSL filesystem and computer sidecars, and the CLI-run
// agent-hooks entry. require("electron") throws MODULE_NOT_FOUND in all of them.
const PLAIN_NODE_ENTRY_NAMES = [
  'daemon-entry',
  'parcel-watcher-process-entry',
  'computer-sidecar',
  'wsl-transcript-fs-process-entry',
  'agent-hooks/managed-agent-hook-controls',
  'codex/codex-app-server-grant-entry'
] as const

// Entries executed as worker threads of the main process. Electron's module is
// not registered on worker threads, so require("electron") throws
// "Cannot find module 'electron'" there too (verified on Electron 43) and kills
// the worker at startup. These carry hand-written "must stay electron-free"
// comments, which is convention, not enforcement — and the port-scan worker in
// particular sits one import away from a client module that deliberately does
// require electron.
const WORKER_THREAD_ENTRY_NAMES = [
  'stt-worker',
  'warp-theme-parser-worker',
  'session-scanner-opencode-sqlite-worker-entry',
  'session-scanner-worker-entry',
  'main-thread-hang-watchdog-entry',
  'port-scan-command-worker-entry'
] as const

export const GUARDED_ENTRY_NAMES = [
  ...PLAIN_NODE_ENTRY_NAMES,
  ...WORKER_THREAD_ENTRY_NAMES
] as const

type EntryRuntime = 'plain-Node process' | 'worker thread'

// Subpaths (electron/main) are as unloadable as the bare module under plain Node.
const ELECTRON_REQUIRE_RE = /require\(\s*["'`]electron(?:\/[^"'`]+)?["'`]\s*\)/

// Why: writeBundle skips any name missing from the bundle, so a renamed or
// removed rollup input would silently drop that entry from the guard and let the
// regression back in. Pin the lists to the input keys at build start instead.
function assertEntryNamesAreRollupInputs(input: NormalizedInputOptions['input']): void {
  if (typeof input === 'string' || Array.isArray(input)) {
    return
  }
  const inputNames = new Set(Object.keys(input))
  const missing = GUARDED_ENTRY_NAMES.filter((name) => !inputNames.has(name))
  if (missing.length > 0) {
    throw new Error(
      `[plain-node-entry-guard] guarded ${missing.map((name) => `"${name}"`).join(', ')} ` +
        `${missing.length === 1 ? 'is not a rollup input' : 'are not rollup inputs'} anymore. ` +
        `Update PLAIN_NODE_ENTRY_NAMES/WORKER_THREAD_ENTRY_NAMES in plain-node-entry-guard.ts to ` +
        `the current entry names — a stale name silently stops guarding that entry.`
    )
  }
}

function collectReachableChunks(
  entry: OutputChunk,
  byFileName: Map<string, OutputChunk>
): OutputChunk[] {
  const seen = new Set<string>()
  const reachable: OutputChunk[] = []
  const stack = [entry.fileName]
  while (stack.length > 0) {
    const fileName = stack.pop() as string
    if (seen.has(fileName)) {
      continue
    }
    seen.add(fileName)
    const chunk = byFileName.get(fileName)
    if (!chunk) {
      continue
    }
    reachable.push(chunk)
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      stack.push(imported)
    }
  }
  return reachable
}

function assertNoElectronRequire(
  entryName: string,
  entry: OutputChunk,
  byFileName: Map<string, OutputChunk>,
  runtime: EntryRuntime = 'plain-Node process'
): void {
  for (const chunk of collectReachableChunks(entry, byFileName)) {
    if (ELECTRON_REQUIRE_RE.test(chunk.code)) {
      throw new Error(
        `[plain-node-entry-guard] "${entryName}" reaches chunk "${chunk.fileName}" that ` +
          `requires electron. "${entryName}" runs as a ${runtime}, where ` +
          `require("electron") throws MODULE_NOT_FOUND and kills it at startup (the ` +
          `v1.4.129-rc.1 daemon outage). Keep electron imports out of its module graph.`
      )
    }
  }
}

// Owned by the argv parser in src/main/daemon/daemon-entry.ts — keep in sync.
const DAEMON_USAGE_PREFIX = 'Usage: daemon-entry'

export type SmokeTimings = {
  timeoutMs: number
  // daemon-entry traps SIGTERM and awaits a native shutdown, so the deadline
  // needs an uncatchable follow-up to stay a deadline.
  killGraceMs: number
}

const DEFAULT_SMOKE_TIMINGS: SmokeTimings = { timeoutMs: 15_000, killGraceMs: 2_000 }

// Bound the wait for stderr to flush after exit; a grandchild inheriting stdio
// can hold the pipes open long after the child is gone.
const SMOKE_STDERR_DRAIN_MS = 250

type SmokeResult = {
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
  error?: Error
  timedOut: boolean
}

// Why not spawnSync({ timeout }): its timeout only sends killSignal and then
// keeps blocking until the child exits, so a child that traps SIGTERM hangs the
// build forever. Escalate to SIGKILL instead.
function runDaemonEntry(entryPath: string, timings: SmokeTimings): Promise<SmokeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entryPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const deadlineTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), timings.killGraceMs)
    }, timings.timeoutMs)

    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadlineTimer)
      clearTimeout(forceKillTimer)
      clearTimeout(drainTimer)
      resolve({ status, signal, stderr, error, timedOut })
    }

    child.on('error', (error: Error) => finish(null, null, error))
    // 'close' gives the full stderr; 'exit' is the fallback so a held-open pipe
    // cannot outlast the process itself.
    child.on('close', (status, signal) => finish(status, signal))
    child.on('exit', (status, signal) => {
      drainTimer = setTimeout(() => finish(status, signal), SMOKE_STDERR_DRAIN_MS)
    })
  })
}

// Why: proves the whole daemon-entry graph resolves under plain Node (no
// unresolved requires). require("electron") does not throw in a dev tree with
// node_modules present, so the static scan above — not this smoke — is the
// electron regression guard; this only catches gross load failures.
async function smokeLoadDaemonEntry(outputDir: string, timings: SmokeTimings): Promise<void> {
  const entryPath = join(outputDir, 'daemon-entry.js')
  const result = await runDaemonEntry(entryPath, timings)
  if (result.error) {
    throw new Error(
      `[plain-node-entry-guard] could not smoke-load daemon-entry.js under plain Node: ` +
        `${result.error.message}`
    )
  }
  // Almost always means the daemon stopped rejecting an empty argv and started
  // listening instead.
  if (result.timedOut) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js did not exit within ${timings.timeoutMs}ms on an ` +
        `empty argv under plain Node, so the smoke killed it.`
    )
  }
  if (result.signal) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js was killed by ${result.signal} under plain Node.`
    )
  }
  const stderr = result.stderr
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js failed to load under plain Node:\n${stderr}`
    )
  }
  if (result.status === 0 || !stderr.includes(DAEMON_USAGE_PREFIX)) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js did not reject an empty argv under plain Node ` +
        `(expected a non-zero exit and the "${DAEMON_USAGE_PREFIX}" error, got exit ` +
        `${result.status}). stderr:\n${stderr}`
    )
  }
}

export function createPlainNodeEntryGuardPlugin(
  smokeTimings: SmokeTimings = DEFAULT_SMOKE_TIMINGS
): Plugin {
  let daemonOutputDir: string | undefined

  return {
    name: 'orca-plain-node-entry-guard',
    buildStart(options: NormalizedInputOptions) {
      assertEntryNamesAreRollupInputs(options.input)
    },
    writeBundle(options: NormalizedOutputOptions, bundle: OutputBundle) {
      // Why: skip in `electron-vite dev` watch mode — the smoke would respawn on
      // every rebuild, and the guard only needs to gate produced builds.
      if (this.meta.watchMode) {
        return
      }
      const chunks = Object.values(bundle).filter(
        (item): item is OutputChunk => item.type === 'chunk'
      )
      const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
      const entryByName = new Map<string, OutputChunk>()
      for (const chunk of chunks) {
        if (chunk.isEntry && chunk.name) {
          entryByName.set(chunk.name, chunk)
        }
      }

      for (const entryName of PLAIN_NODE_ENTRY_NAMES) {
        const entry = entryByName.get(entryName)
        if (entry) {
          assertNoElectronRequire(entryName, entry, byFileName, 'plain-Node process')
        }
      }

      for (const entryName of WORKER_THREAD_ENTRY_NAMES) {
        const entry = entryByName.get(entryName)
        if (entry) {
          assertNoElectronRequire(entryName, entry, byFileName, 'worker thread')
        }
      }

      if (entryByName.has('daemon-entry') && options.dir) {
        daemonOutputDir = options.dir
      }
    },
    async closeBundle() {
      if (daemonOutputDir) {
        const outputDir = daemonOutputDir
        daemonOutputDir = undefined
        await smokeLoadDaemonEntry(outputDir, smokeTimings)
      }
    }
  }
}
