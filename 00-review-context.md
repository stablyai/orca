# Review Context

## Branch Info

- Base: origin/main (merge-base b19db2301df9fe908386318207d15d65157c6d9b)
- Current: brennanb2025/pr2-agent-hooks

## Changed Files Summary

| Status | Path |
| ------ | ---- |
| M | src/cli/runtime-client.ts |
| A | src/main/agent-hooks/installer-utils.test.ts |
| A | src/main/agent-hooks/installer-utils.ts |
| A | src/main/agent-hooks/server.test.ts |
| A | src/main/agent-hooks/server.ts |
| A | src/main/claude/hook-service.ts |
| A | src/main/codex/hook-service.ts |
| A | src/main/gemini/hook-service.ts |
| M | src/main/index.ts |
| A | src/main/ipc/agent-hooks.ts |
| M | src/main/ipc/pty.test.ts |
| M | src/main/ipc/pty.ts |
| M | src/main/ipc/register-core-handlers.test.ts |
| M | src/main/ipc/register-core-handlers.ts |
| A | src/main/opencode/hook-service.test.ts |
| M | src/main/opencode/hook-service.ts |
| M | src/main/providers/provider-dispatch.test.ts |
| M | src/preload/api-types.d.ts |
| M | src/preload/index.d.ts |
| M | src/preload/index.ts |
| M | src/renderer/src/components/settings/CliSection.tsx |
| M | src/renderer/src/components/terminal-pane/TerminalPane.tsx |
| M | src/renderer/src/components/terminal-pane/pty-connection.ts |
| M | src/renderer/src/components/terminal-pane/pty-dispatcher.ts |
| M | src/renderer/src/components/terminal-pane/pty-transport.test.ts |
| M | src/renderer/src/components/terminal-pane/pty-transport.ts |
| M | src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts |
| M | src/renderer/src/hooks/useIpcEvents.ts |
| M | src/shared/agent-status-types.ts |
| M | src/shared/types.ts |

## Changed Line Ranges (PR Scope)

<!-- In scope: issues on these lines OR caused by these changes. Out of scope: unrelated pre-existing issues -->

| File | Changed Lines |
| ---- | ------------- |
| src/cli/runtime-client.ts | 389-392 |
| src/main/agent-hooks/installer-utils.test.ts | 1-144 (new file) |
| src/main/agent-hooks/installer-utils.ts | 1-144 (new file) |
| src/main/agent-hooks/server.test.ts | 1-701 (new file) |
| src/main/agent-hooks/server.ts | 1-1071 (new file) |
| src/main/claude/hook-service.ts | 1-222 (new file) |
| src/main/codex/hook-service.ts | 1-234 (new file) |
| src/main/gemini/hook-service.ts | 1-212 (new file) |
| src/main/index.ts | 35-37, 148-160, 187-202, 260-275, 316-320 |
| src/main/ipc/agent-hooks.ts | 1-24 (new file) |
| src/main/ipc/pty.test.ts | 20-26, 39-45, 46-48, 80-85, 126-130, 144-147, 301-305, 309-322, 492-500 |
| src/main/ipc/pty.ts | 6-12, 28-34, 117-125, 175-200, 203-220, 351-362, 367, 373-380 |
| src/main/ipc/register-core-handlers.test.ts | 18-23, 46-50, 131-134, 173-177, 208-212 |
| src/main/ipc/register-core-handlers.ts | 26-28, 66-68 |
| src/main/opencode/hook-service.test.ts | 1-21 (new file) |
| src/main/opencode/hook-service.ts | 1-251 (major rewrite) |
| src/main/providers/provider-dispatch.test.ts | 14-18 |
| src/preload/api-types.d.ts | 28-32, 66-68, 347-350, 451-455 |
| src/preload/index.d.ts | 9-13, 83-85, 194-216, 221-226 |
| src/preload/index.ts | 8-14, 317-322, 478-486, 1522-1557 |
| src/renderer/src/components/settings/CliSection.tsx | 21-25, 102-108, 208-240 |
| src/renderer/src/components/terminal-pane/TerminalPane.tsx | 295-297 |
| src/renderer/src/components/terminal-pane/pty-connection.ts | 7-10, 72-74, 170-185, 196-198, 206-222 |
| src/renderer/src/components/terminal-pane/pty-dispatcher.ts | 8-18, 35-38, 51-56, 209-211 |
| src/renderer/src/components/terminal-pane/pty-transport.test.ts | 7-60, 188-300, 290-300 |
| src/renderer/src/components/terminal-pane/pty-transport.ts | 1-4, 11-16, 21-23, 39-145, 157-170, 186-370, 423-440 |
| src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts | 479-483 |
| src/renderer/src/hooks/useIpcEvents.ts | 1, 21-23, 660-702, 704-748 |
| src/shared/agent-status-types.ts | 202-260, 263-270 |
| src/shared/types.ts | 787-790 |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main

- src/main/agent-hooks/installer-utils.test.ts
- src/main/agent-hooks/installer-utils.ts
- src/main/agent-hooks/server.test.ts
- src/main/agent-hooks/server.ts
- src/main/claude/hook-service.ts
- src/main/codex/hook-service.ts
- src/main/gemini/hook-service.ts
- src/main/index.ts
- src/main/opencode/hook-service.test.ts
- src/main/opencode/hook-service.ts
- src/main/providers/provider-dispatch.test.ts
- src/preload/api-types.d.ts
- src/preload/index.d.ts
- src/preload/index.ts

### Backend/IPC

- src/main/ipc/agent-hooks.ts
- src/main/ipc/pty.test.ts
- src/main/ipc/pty.ts
- src/main/ipc/register-core-handlers.test.ts
- src/main/ipc/register-core-handlers.ts

### Frontend/UI

- src/renderer/src/components/settings/CliSection.tsx
- src/renderer/src/components/terminal-pane/TerminalPane.tsx
- src/renderer/src/components/terminal-pane/pty-connection.ts
- src/renderer/src/components/terminal-pane/pty-dispatcher.ts
- src/renderer/src/components/terminal-pane/pty-transport.test.ts
- src/renderer/src/components/terminal-pane/pty-transport.ts
- src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts
- src/renderer/src/hooks/useIpcEvents.ts

### Config/Build

(none)

### Utility/Common

- src/cli/runtime-client.ts
- src/shared/agent-status-types.ts
- src/shared/types.ts

## Skipped Issues (Do Not Re-validate)

<!-- Issues validated but deemed not worth fixing. Do not re-validate these in future iterations. -->
<!-- Format: [file:line-range] | [severity] | [reason skipped] | [issue summary] -->

- [src/main/agent-hooks/installer-utils.ts:113-123] | Low | Intentional: falls through to safe atomic write | Read-error during identity check still triggers .bak rotation
- [src/main/ipc/agent-hooks.ts:11-24 sender validation] | Low | Consistent with other status-only handlers (cli.ts, etc.) — no project-wide pattern to match | Missing event.senderFrame/trusted-renderer guards on getStatus handlers
- [src/main/ipc/pty.ts:351-362 double buildPtyEnv] | Low | Intentional and tested; both call sites cover local+daemon provider paths | Redundant agentHookServer.buildPtyEnv() in buildSpawnEnv and pty:spawn handler
- [Provider registry refactor across server.ts/index.ts/agent-hooks.ts/hook-service.ts] | Medium | Architectural change out of scope for this hardening pass | Hardcoded per-provider enumeration in N files; should be a registry
- [Shared base class/helper for claude/codex/gemini hook services] | Medium | Architectural change out of scope; files already use shared installer-utils primitives | ~670 LOC of per-provider duplication
- [src/main/opencode/hook-service.ts:63-81 isChildSession fail-closed] | Medium | Intentional design choice, documented in comment | Fallback to true can silently drop permission.asked for root session on transient SDK errors
- [src/main/opencode/hook-service.ts:46-55 messageRoleById FIFO-not-LRU] | Low | Documented capped cache; bug only triggers after 128 distinct messageIDs seen within a live turn — negligible | Map eviction is FIFO rather than LRU
- [src/main/agent-hooks/server.ts:886-887 tabId/worktreeId length bound] | Low | Total body cap already bounds total damage; symmetric bound would be belt-and-braces | tabId/worktreeId not explicitly length-capped like paneKey
- [src/main/ipc/pty.ts:223 Windows PATH case-sensitivity] | Medium | Dev-mode only (!app.isPackaged); Windows dev is uncommon; pre-existing PATH handling pattern | PATH vs Path env key normalization
- [src/renderer/src/hooks/useIpcEvents.ts:712-745 resolvePaneKey O(NxM)] | Medium | Pre-existing hot-path pattern; optimization requires store indexing changes beyond scope | Full scan of tabsByWorktree per agent-status event
- [src/renderer/src/components/terminal-pane/pty-connection.ts:186-192 connectionId O(N) scan] | Medium | Pre-existing pattern; scoped to per-pane mount, not hot path | worktreesByRepo/repos linear lookup
- [src/renderer/src/components/terminal-pane/pty-transport.ts:184-192 unregisterPtyDataAndStatusHandlers naming] | Low | Stale naming only; no functional impact | Misleading function name after status-handler removal
- [src/renderer/src/components/terminal-pane/pty-transport.ts component cohesion] | Low | Architectural split out of scope; file already has oxlint-disable with justification | createIpcPtyTransport spans 4 responsibilities
- [src/cli/runtime-client.ts:389-392 comment phrasing] | Low | Minor documentation nit | Comment claims parallel-instance support that isn't fully wired
- [src/preload/index.d.ts:194-210 AgentStatusApi typed inline] | Medium | Derive from shared AgentStatusPayload would improve type-drift safety, but requires cross-file renames; defer to follow-up | Preload callback type hand-duplicates ParsedAgentStatusPayload shape
- [src/shared/agent-status-types.ts:252 normalizeAgentStatusPayload wrapper] | Low | Cleanup nit; no functional issue | Wrapper adds indirection with no behavior change
- [src/renderer/src/components/settings/CliSection.tsx useEffect deps] | Low | Harmless lint nit, not caused by PR | Empty deps with closure over refreshStatus
- [src/renderer/src/components/terminal-pane/pty-connection.ts:316-321 pendingSpawnByTabId.set ordering] | Low | Benign: .finally only deletes, never reads mid-settle | Set called after chain construction
- [src/main/index.ts:189-201 sync install blocking startup] | Medium | Disk I/O is fast on user-local config paths; move to microtask would complicate error reporting path | Sync install on whenReady
- [src/renderer/src/components/terminal-pane/TerminalPane.tsx:316-322 unmount-race] | Low | Pre-existing pattern; managerRef guards already in place downstream | hasChildProcesses promise not canceled on unmount
- [src/renderer/src/components/terminal-pane/pty-transport.ts:305-309 destroyed-after-spawn] | Medium | Current fire-and-forget kill is intentional; upstream already tearing down | No exit notification on mid-spawn destroy
- [Multiple test-gap findings] | Low | Test coverage improvements are follow-up work; do not affect correctness of the PR's production changes | New integration tests for clearPaneState bookkeeping etc.

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []

### Iteration 1 validated fix manifest

- src/main/agent-hooks/server.ts
  - Wrap replay listener call in try/catch (line 919-921) so one throwing pane doesn't starve replay for the rest
  - Clear warnedVersions / warnedEnvs in stop() and _internals.resetCachesForTests (line 1018-1031, 1066-1070)
- src/main/ipc/pty.ts
  - Call clearProviderPtyState(args.id) in pty:kill finally block (line 413-425) so SSH/daemon PTY kills do not leak ptyPaneKey
  - Extend clearPtyOwnershipForConnection to also clear ptyPaneKey + call agentHookServer.clearPaneState (line 101-107)
  - Validate args.env?.ORCA_PANE_KEY (string + length <= 256) before setting ptyPaneKey (line 373-380)
- src/main/ipc/agent-hooks.ts
  - Prepend ipcMain.removeHandler for each channel before ipcMain.handle (defensive; matches pty.ts pattern)
  - Wrap each getStatus call in try/catch, returning an AgentHookInstallStatus with state:'error' on thrown exceptions (error-shape contract)
- src/main/index.ts
  - Add window.on('closed', () => agentHookServer.setListener(null)) so the listener doesn't fire into a destroyed webContents and doesn't replay on every window recreate
- src/main/opencode/hook-service.ts
  - In message.part.updated handler, skip the event when role is not in messageRoleById (remove default-to-assistant so user input is never tagged as assistant output)
