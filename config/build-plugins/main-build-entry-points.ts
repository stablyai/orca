import { resolve } from 'node:path'
import { ORCAD_LOCAL_SERVE_SELECTION_ENTRY } from '../../src/shared/orcad-local-serve-selection'
import { CLI_MAIN_ENTRY_NAMES } from './plain-node-entry-guard'

/** Main-build Rollup inputs: output file name (without .js) to its source entry. */
export const MAIN_BUILD_ENTRY_POINTS: Record<string, string> = {
  index: resolve('src/main/index.ts'),
  // Why: sandboxed webview preloads cannot load Rollup helper chunks.
  'browser-window-close-preload': resolve('src/preload/browser-window-close.ts'),
  'doc-preview-link-preload': resolve('src/preload/doc-preview-link.ts'),
  'daemon-entry': resolve('src/main/daemon/daemon-entry.ts'),
  'plugin-host-entry': resolve('src/main/plugins/plugin-host-entry.ts'),
  'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
  'stt-worker': resolve('src/main/speech/stt-worker.ts'),
  'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
  'foreign-sqlite-reader-entry': resolve(
    'src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry.ts'
  ),
  'session-scanner-service-entry': resolve('src/main/ai-vault/session-scanner-service-entry.ts'),
  'wsl-transcript-fs-process-entry': resolve(
    'src/main/native-chat/wsl-transcript-fs-process-entry.ts'
  ),
  // Why: libuv spawns processes inline on the calling loop, so the port
  // scan's probe commands run on a worker thread instead of the UI one.
  'port-scan-command-worker-entry': resolve('src/main/ports/port-scan-command-worker-entry.ts'),
  // Why (#27362): the Codex usage probe spawns on window focus; a cold
  // CreateProcessW must not block the UI loop.
  'worker-thread-child-process-entry': resolve(
    'src/main/worker-thread-child-process/worker-thread-child-process-entry.ts'
  ),
  // Why: the Claude/Codex/OpenCode usage scans walk whole history
  // corpora and read SQLite synchronously; a worker thread keeps that
  // off the main-process event loop.
  'usage-scan-worker-entry': resolve('src/main/usage/usage-scan-worker-entry.ts'),
  'workspace-space-scan-worker-entry': resolve('src/main/workspace-space-scan-worker-entry.ts'),
  // Why: a first account setup can merge a large history tree with sync fs calls.
  'claude-profile-setup-worker-entry': resolve(
    'src/main/claude-accounts/claude-profile-setup-worker-entry.ts'
  ),
  'profile-state-backup-worker-entry': resolve(
    'src/main/persistence/profile-state/profile-state-backup-worker-entry.ts'
  ),
  'profile-state-writer-worker-entry': resolve(
    'src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'
  ),
  // Why: forked with ELECTRON_RUN_AS_NODE so @parcel/watcher faults
  // can't take down the main process (issue #7547).
  'parcel-watcher-process-entry': resolve('src/main/ipc/parcel-watcher-process-entry.ts'),
  // Why: `orca serve` runs it under ELECTRON_RUN_AS_NODE so the CLI never bundles orcad prep.
  [ORCAD_LOCAL_SERVE_SELECTION_ENTRY]: resolve(
    'src/main/orcad/orcad-local-serve-selection-entry.ts'
  ),
  // Why: a worker thread survives the macOS 26 AppKit main-thread deadlock
  // without paying for another Electron process.
  'main-thread-hang-watchdog-entry': resolve(
    'src/main/hang-watchdog/main-thread-hang-watchdog-entry.ts'
  ),
  ...Object.fromEntries(
    CLI_MAIN_ENTRY_NAMES.map((module) => [module, resolve(`src/main/${module}.ts`)])
  )
}
