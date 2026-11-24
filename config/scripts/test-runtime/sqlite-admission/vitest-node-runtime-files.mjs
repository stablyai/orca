import { findSqliteRuntimeTests } from './vitest-sqlite-runtime-scan.mjs'

// SQLite publication, native bindings, worker IPC, socket liveness, and V8 retention use Node.
const NODE_RUNTIME_INCLUDE = [
  // The parse cache persists through node:sqlite.
  'src/main/ai-vault/parse-cache/session-parse-cache-persistence.test.ts',
  // The relay's backpressure rides on Node's fetch; Bun's fetch reads a body ahead of its reader.
  'src/main/bots/tool-relay/bot-tool-relay.test.ts',
  // A failed write must surface as Node's async stream 'error', as on Electron main's stdio.
  'src/renderer/src/components/terminal-pane/pty-transport/input/pty-input-write-queue.test.ts',
  'src/cli/**/*.test.ts',
  'src/main/persistence/**/*.test.ts',
  'src/main/persistence*.test.ts',
  'src/main/sqlite/**/*.test.ts',
  'src/main/orca-profiles/**/*.test.ts',
  'src/main/managed-data-accounts/**/*.test.ts',
  'src/**/*.node-pty.test.ts',
  'src/**/node-pty-*.test.ts',
  'src/**/*.live-shell.test.ts',
  'src/**/*real-pty*.test.ts',
  'src/**/*-native.test.ts',
  'src/**/*retention*.test.ts',
  'src/**/*lifetime*.test.ts',
  'src/**/*memory*.test.ts',
  'src/**/*allocation*.test.ts',
  'src/**/*expiry*.test.ts',
  'src/main/git/worktrees/removal/worktree-removal-real-git.test.ts',
  'src/main/foreign-sqlite-readers/**/*.test.ts',
  'src/main/browser/*cookie*.test.ts',
  'src/main/browser/cookies/*cookie*.test.ts',
  'src/main/browser/cookies/client-route/*cookie*.test.ts',
  'src/main/browser/cookies/chromium/chromium-cookie-snapshot.test.ts',
  'src/shared/workspace-session/workspace-session-salvage.test.ts',
  'src/main/native-chat/paste-files/native-chat-paste-files.test.ts',
  'src/main/native-chat/agent-session-journal/**/*.test.ts',
  'src/main/runtime/rpc/methods/structured-sessions/attachments/structured-agent-session-visual.test.ts',
  // Bun on macOS fails its read-only directory case with ENOTEMPTY; Node passes it.
  ...(process.platform === 'darwin'
    ? ['config/scripts/worktree-storage/reclaim-worktree-generated-files.test.mjs']
    : [])
]

/** `filters` limits the SQLite import scan to the tests a filtered CLI run can select. */
export function getNodeRuntimeInclude({ filters } = {}) {
  return [...NODE_RUNTIME_INCLUDE, ...findSqliteRuntimeTests({ filters })]
}
