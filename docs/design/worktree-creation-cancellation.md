# Worktree creation cancellation

Closing a pending sidebar row used to discard only its renderer entry. The outstanding create still completed, inserted a usable workspace, and could seed terminals after a late trust preflight.

## Contract

`worktree.creation-cancellation`: cancelling an unfinished creation stops subsequent dispatch/retries, activation, and renderer startup. When an already-dispatched create returns a workspace, the attempt removes that exact host-qualified workspace using the existing removal path. Completion and cancellation have a synchronous cut point immediately before the normal handoff clears the pending entry.

Git mutations already in progress settle before cleanup; this change does not interrupt Git mid-mutation. Deletion can briefly show its ordinary progress row. Cleanup is compensating work, not a guarantee that no temporary checkout ever reaches disk.

## Implementation

A session-local attempt owns the cancellation flag, captured workspace, and optional VM cleanup. The sidebar and creation panel already call the same pending-removal action, which now cancels that attempt. After a post-create startup failure, ownership lasts until the error panel is dismissed or recovery completes.

The create store checks cancellation before dispatch, conflict retries, and missing-parent retries. Its callbacks remain renderer-only and are never serialized into IPC/RPC. Capture host ownership before the asynchronous create, and use it for both result reconciliation and cleanup, even if runtime focus changes.

Cleanup reuses host-qualified removal, skips archive hooks for the unfinished workspace, and requests force removal of its checkout while retaining the existing requirement for verified process termination. A captured instance ID refuses a replacement already observed at the same path. Folder workspaces retain their existing registration-only deletion semantics. VM teardown waits for creation and workspace removal to settle.

A cleanup failure leaves the workspace recoverable and displays a persistent error. It never substitutes local deletion for an unavailable remote host. Existing Git deletion and branch-preservation policies remain authoritative.

## Performance

Successful creation adds synchronous flag checks and one bounded attempt record. It adds no RPC, Git process, polling, timer, or awaited I/O. Regression tests count one create call on success, zero dispatch for an already-cancelled request, no retry after cancellation, zero removal on normal completion, and one cleanup for repeated cancellation. Additional cleanup I/O runs only for cancelled attempts.

## Verification and limits

Deterministic tests cover early cancellation, late success, trust-preflight cancellation, sticky cancellation, settled startup failure, owning-host capture, replacement-instance refusal, cleanup failure, and ordinary successful creation. The experimental reliability gate records these tests.

A hidden macOS Electron instance exercises the sidebar Cancel button with a real temporary Git repository and a deliberately held completion. Git's worktree list, the filesystem, and the rendered sidebar must agree after cancellation. Screenshots are review artifacts rather than repository assets.

Real Windows/WSL/SSH and paired-runtime cancellation are not exercised locally; routing and failure behavior have mocked contract coverage. Cancellation ownership is renderer-session memory: renderer termination or a remote create whose outcome is never returned cannot be reconciled by this attempt. Durable host-owned cancellation across disconnect/restart remains outside this change. No new wire fields or protocol capabilities are introduced.
