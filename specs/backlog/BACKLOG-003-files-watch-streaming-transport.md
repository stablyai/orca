# BACKLOG-003: `files.watch` — live external file-change notifications for remote targets

**Origin:** `specs/backend-go/bugs/missing-v3/BUG-015-files-createfile-watch-browseserverdir-not-implemented.md`, `specs/backend-go/bugs/missing-v3/tasks/TASK-BUG015-files-watch-blocked-on-agent-fswatch.md`
**Priority:** Medium — degrades silently (no crash), but is a real, everyday-visible gap
**Blocked on:** A new streaming transport between the Dev Server Agent, `git-gateway-service`, and `wscompat` — genuine capability work, not wiring

---

## What this is

The file explorer's live refresh and the editor's "file changed on disk,
reload?" prompt both subscribe to `files.watch` for a worktree. For any
remote/environment runtime target, this channel doesn't exist —
`subscribeRuntimeFileChanges`'s caller catches the resulting error and
degrades silently, so the practical effect is: **no external file change
(an agent's terminal session editing a file, another collaborator, etc.)
ever reaches a remote target's UI without a manual refresh.** Not a crash,
just permanently stale until the user does something else that happens to
re-fetch (e.g. `workspace.refreshFileTree`).

## Why it's blocked

**The Dev Server Agent side already exists and is fully shipped** —
`agent/src/relay/fs-agent-extensions.ts` has a real, refcounted, tested
`fs.watch`/`fs.unwatch` primitive that pushes `fs.changed` notifications,
already advertised in the agent's own capability list. This is NOT a
"build a file watcher" problem.

**What's missing is the transport to carry that push notification up to the
browser.** Checked both services in the path:

- `infra-fleet-service` only has two dedicated bidirectional streams today
  (`AttachPty`, `AttachScreencast`) — no generic "subscribe to arbitrary
  agent-pushed events for a connection" primitive.
- `git-gateway-service`'s `.proto` has **zero** streaming RPCs — every
  method it exposes is unary request/response (including its only
  `infra-fleet-service` dependency, plain `Relay`/`RelayByDevServer`).

Building this — a new streaming RPC (proto), a new `wscompat` stream
channel (`RegisterStreamChannel`, the same mechanism `terminal.create`
uses for PTY output), and the plumbing to route one agent's `fs.changed`
events to potentially multiple subscribed browser clients — is comparable
in scope to what `AttachPty` itself once required. Not "just wiring."

## What it would take (sketch)

1. A new streaming RPC on `git-gateway-service` (or `infra-fleet-service`,
   whichever ends up owning the relay — `git-gateway-service` is the
   domain owner of worktree-scoped file I/O per every other `files.*`
   method) — e.g. `WatchWorktree(WatchWorktreeRequest) returns (stream
   FileChangeEvent)`.
2. Server-side: resolve the worktree to a connection (same pattern every
   other `files.*`/`git.*` method already uses), call the agent's
   `fs.watch`, and forward each `fs.changed` push as a `FileChangeEvent`
   down the new stream.
3. `wscompat`: a `files.watch` channel via `RegisterStreamChannel`, mirroring
   `channels_terminal.go`'s `registerTerminalCreateChannel`/
   `drainAttachPtyOutput` pattern — open the new stream, forward each
   `FileChangeEvent` as a `PushEvent` to the browser, clean up on
   disconnect/`files.unwatch`.
4. Multi-subscriber handling: unlike a PTY (one session, one primary
   attacher), multiple browser tabs/clients could plausibly watch the same
   worktree — decide whether the agent's own refcounted `fs.watch` handles
   this already (likely yes, per its "refcounted" design) or whether
   `wscompat`/`git-gateway-service` also need fan-out logic for multiple
   `wscompat` connections sharing one underlying agent watch.

## References

- `agent/src/relay/fs-agent-extensions.ts` — the already-shipped agent-side primitive
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go:217-268` — the `RegisterStreamChannel`/`AttachPty` pattern to mirror
- `frontend/src/renderer/src/runtime/runtime-file-client.ts:876-892` — `files.watch`'s real frontend call site (`subscribeRuntimeFileChanges`)
- `frontend/src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts:320`, `frontend/src/renderer/src/hooks/useEditorExternalWatch.ts:314` — live consumers
