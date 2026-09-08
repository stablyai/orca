// src/relay/browser-handler.ts
// Part A (agent-rpc-dispatch.ts) implementation of browser.* — driving a real
// headless Chromium process ON THIS HOST, relayed from backend-go's
// wscompat/channels_browser.go via infra-fleet-service's Relay RPC.
//
// Why this exists (TASK-036 option b): the OLD `browser.*` feature
// (backend/src/main/browser/agent-browser-bridge.ts) drove Electron's own
// embedded WebContents via CDP — desktop-local, not reachable from a remote
// SSH-connected dev server. This is a genuinely new capability, not a port:
// the Dev Server Agent launches and drives its OWN headless browser process.
//
// Engine choice: `agent-browser` (vercel-labs) is already a vendored
// dependency (agent/package.json) and is the exact engine the OLD Electron
// bridge already shelled out to (see `execAgentBrowser` in
// agent-browser-bridge.ts) — it bundles/locates a real Chrome/Chromium,
// speaks CDP internally, and exposes the goto/click/snapshot/eval/mouse/tab
// vocabulary this file needs as a CLI with `--json` output. Reusing it here
// means this file does not hand-roll a CDP client — it shells out to a
// proven automation engine already in this codebase's dependency graph,
// exactly like the desktop bridge did, just against a real launched browser
// instead of an Electron WebContents.
//
// Session-scoping/cleanup model (decided here, since nothing upstream
// specifies one):
//   - One `agent-browser` session per worktree, keyed by `params.worktree`
//     via the CLI's `--session <worktreeId>` flag. `agent-browser` itself
//     keeps a persistent background daemon + Chrome process alive across
//     separate CLI invocations for the same `--session` name (confirmed by
//     spawning it: the daemon reparents to pid 1 and outlives the invoking
//     process) — so this file does NOT need to manage a long-lived child
//     process itself; each RPC call is a short-lived CLI invocation that
//     talks to (or lazily creates) that session's daemon.
//   - Idle timeout (primary cleanup mechanism): every invocation sets
//     AGENT_BROWSER_IDLE_TIMEOUT_MS so the daemon self-terminates after
//     BROWSER_SESSION_IDLE_TIMEOUT_MS of inactivity. Without this, a
//     worktree's headless Chrome process leaks on the host forever once
//     used even once — verified in this sandbox (leftover daemon + ~15
//     Chrome subprocesses per session after testing without it).
//   - Explicit teardown: `browser.tabClose` fully closes the session's
//     browser (not just the tab) once no tabs remain, so closing the last
//     browser-pane tab in the UI frees the host process immediately instead
//     of waiting out the idle timeout.
//   - NOT implemented (documented gap, not silently assumed): teardown tied
//     to the Orca<->agent WebSocket connection closing. Each browser.* call
//     is a stateless RPC dispatch with no connection-lifecycle hook wired in
//     this pass (agent-rpc-dispatch.ts's per-connection WireState is not
//     plumbed to this handler). The idle timeout is the safety net for a
//     dropped connection.
//
// Capability requirement this creates: the target host must have a
// Chrome/Chromium install `agent-browser` can find (or network access for
// its own first-run download). runBrowserCommand() maps the CLI's own
// "no usable browser" failure into a clear BROWSER_ENGINE_UNAVAILABLE error
// instead of a opaque spawn/exit-code failure.
//
// ── File layout ──────────────────────────────────────────────────────────
// This file is now a re-export barrel: the implementation above was split,
// to stay under oxlint's max-lines budget, across:
//   - browser-command-runner.ts — CLI resolution/execution, the session/
//     idle-timeout plumbing described above, and shared JSON-RPC/param
//     helpers.
//   - browser-page-handlers.ts — per-worktree page handlers (goto,
//     snapshot, click, eval, keypress, mouse*, viewport, tab*).
//   - browser-profile-handlers.ts — dev-server-wide profile handlers
//     (profileClearDefaultCookies, profileDetectBrowsers).
// Kept as a barrel, rather than repointing every import, because
// agent-rpc-dispatch-browser.ts's RPC switch and browser-screencast-handler.ts
// both resolve handlers via `await import('./browser-handler')` / a static
// import of this path — this file's public API must stay stable for them.

export type { BrowserCommandParams } from './browser-command-runner'
export { requireWorktreeId, runBrowserCommand } from './browser-command-runner'

export {
  handleBrowserGoto,
  handleBrowserSnapshot,
  handleBrowserClick,
  handleBrowserEval,
  handleBrowserKeypress,
  handleBrowserMouseMove,
  handleBrowserMouseDown,
  handleBrowserMouseUp,
  handleBrowserMouseWheel,
  handleBrowserViewport,
  handleBrowserTabCreate,
  handleBrowserTabClose
} from './browser-page-handlers'

export {
  handleBrowserProfileClearDefaultCookies,
  handleBrowserProfileDetectBrowsers
} from './browser-profile-handlers'
