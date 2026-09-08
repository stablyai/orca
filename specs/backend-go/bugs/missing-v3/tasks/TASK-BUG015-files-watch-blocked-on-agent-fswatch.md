# TASK-BUG015: `files.watch` — blocked on a missing streaming RPC surface in `infra-fleet-service`/`git-gateway-service`, NOT on the agent

**From:** BUG-015 (`specs/backend-go/bugs/missing-v3/BUG-015-files-createfile-watch-browseserverdir-not-implemented.md`)
**Priority:** P3 — documentation only; `files.watch`'s absence degrades gracefully (file explorer/editor only miss live external-change notifications for remote/environment targets, per BUG-015's own impact note — no crash, no core-action failure)
**Service:** `agent` (the primitive already exists here — NOT the blocker) / `infra-fleet-service` and `git-gateway-service` (where the missing streaming RPC surface would need to be built)
**File:** none changed by this task — documentation/reference only, matching `TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md`'s "honest blocker" precedent
**Status:** `[ ]` TODO

---

## What this task actually is

BUG-015 asked for an investigation of whether the Dev Server Agent already has a file-watch/push-notification primitive before attempting `files.watch`, with an explicit instruction: implement it for real only if it's genuinely a bridging/wiring job (agent primitive exists, only the plumbing is missing); write an honest-blocker doc instead if it's a real capability gap.

**The investigation found a split result that the bug's own two-way framing doesn't cleanly capture:** the agent-side primitive is fully real and already shipped, but the transport layer needed to carry its push events up through `infra-fleet-service` and `git-gateway-service` to `api-gateway`/`wscompat` does not exist for anything other than PTY and screencast frames. Building that transport is comparable in scope to what `AttachPty`'s own streaming RPC once required — genuine new capability engineering, not a small bridging patch. Per BUG-015's decision rule, this is being left unimplemented with this doc as the record, rather than forced.

## The agent-side primitive is real (confirmed, not assumed)

Unlike `TASK-006`'s ephemeral-VM-SSH gap (nothing in `agent/` at all), `files.watch` is a fully working, tested agent feature today:

- `agent/src/relay/fs-agent-extensions.ts:667-807` implements `handleFsWatch`/`handleFsUnwatch`: recursive, refcounted-per-path watching (`AGENT_WATCH_MAP`), backed by Node's native `fs.watch(recursive: true)` where the platform supports it, with a `watchDirLinux`/`handleLinuxWatchEvent` polyfill (per-subdirectory `fs.watch` instances) for Linux, where native `recursive` isn't supported. Multiple watchers on the same path share one underlying watch (`fs.watch / fs.unwatch` doc comment: "Two callers ... can watch the same path without one's unwatch tearing it down for the other").
- `agent/src/relay/agent-rpc-dispatch-fs.ts:137-161` dispatches `fs.watch`/`fs.unwatch` JSON-RPC calls to those handlers.
- `agent/src/relay/agent-session.ts:120-170` lists `fs.watch` in the agent's own advertised capability set (`buildCapabilities`/`STATIC_CAPABILITIES_FALLBACK`) — a first-class, always-present capability, not experimental or conditional on anything.
- Change events are pushed back over the agent's own WebSocket connection as a `fs.changed` JSON-RPC **notification** (no `id`), using the same one-way notifier every other long-lived agent resource (PTY sessions included) uses: `agent/src/relay/agent-rpc-dispatch.ts:264-271`'s `makeNotifier` doc comment: *"Used by long-lived agent-side resources (PTY sessions, fs watchers) to push data back to Orca outside the request/response cycle."*
- This is exhaustively covered by `agent/src/relay/fs-handler.ts` (`RelayFilesystemWatchRegistry`), `relay-filesystem-watch-registry.ts`, `relay-watcher-process-pool.ts`, and their test files — a mature, production subsystem, not a stub.

Re-run this before picking the task back up — `agent/` may have changed since this was last confirmed:

```bash
grep -n "fs.watch\|fs.changed" agent/src/relay/agent-rpc-dispatch-fs.ts agent/src/relay/fs-agent-extensions.ts
```

## Where the real gap is: no generic push-event transport exists between the agent and `git-gateway-service`/`api-gateway`

`fs.changed` is a raw JSON-RPC notification traveling over the agent's single flat WebSocket connection to whichever backend-go component terminates it (`infra-fleet-service`, per the Dev Server Agent connection architecture). That connection carries every method the agent supports as a shared wire — `fs.changed` is on that wire exactly the same way PTY output frames are. But **nothing on the `infra-fleet-service` side turns that shared wire into a gRPC-level event stream for `fs.changed` today**:

```
$ grep -n "stream " backend-go/proto/orca/infrafleet/v1/infrafleet.proto
  rpc AttachPty(stream PtyClientFrame) returns (stream PtyServerFrame);
  rpc AttachScreencast(stream ScreencastClientFrame) returns (stream ScreencastServerFrame);
```

Both are purpose-built, dedicated bidi streams for their own domain (`infra-fleet-service/internal/usecase/attach_pty.go`, `attach_screencast.go`, wired in `infra-fleet-service/internal/adapter/grpc/server.go`) — each required real, non-trivial engineering to build: a usecase-level message shape (`PtyClientMessage`/`PtyServerMessage`), a per-session correlation/demux layer pulling the right notifications off the agent's shared connection, and the gRPC adapter plumbing both directions. There is no generic "subscribe to any agent-pushed notification by method name" RPC that `fs.changed` could ride for free.

```
$ grep -rln "fs.changed\|fsChanged\|FsChanged" backend-go/services/infra-fleet-service/
(no matches)
```

Confirms `infra-fleet-service` has never consumed or forwarded an `fs.changed` notification — this is not a partially-wired feature, it is unstarted at the transport layer.

Compounding this: `files.*` channels are `git-gateway-service`'s domain (`registerFilesChannels` dispatches through `gitgatewayv1.GitGatewayServiceClient`, not directly through `infrafleetv1.InfraFleetServiceClient`), and `gitgateway.proto` has **zero** streaming RPCs of any kind today (`grep -n "rpc " backend-go/proto/orca/gitgateway/v1/gitgateway.proto` — every RPC is unary). `git-gateway-service`'s only channel to `infra-fleet-service` for filesystem work is `RelayExecutor`'s use of the unary `Relay`/`RelayByDevServer` RPCs (`backend-go/services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go`) — a single request/response round trip per call, with no mechanism to hold a channel open for server-pushed events at all.

So shipping `files.watch` for real needs, at minimum:

1. A new streaming RPC in `infrafleet.proto` (server-streaming or bidi, mirroring `AttachPty`'s shape) that opens `fs.watch` on the agent for a given connection/path and forwards `fs.changed` notifications as they arrive — plus the `infra-fleet-service` usecase/adapter code to implement it (a new `attach_pty.go`-equivalent file, a new demux path off the agent's shared notification stream).
2. A corresponding streaming RPC surface in `gitgateway.proto` (since `files.*` is `git-gateway-service`'s domain, per BUG-015's own "owning service" analysis) that resolves worktree→connection and proxies the `infra-fleet-service` stream — `git-gateway-service` has no precedent for holding open a streaming call to `infra-fleet-service` today; every existing dispatch is unary.
3. A new `wscompat` `RegisterStreamChannel` registration for `files.watch` (this part genuinely would mirror `terminal.create`'s `channels_terminal.go` pattern closely, and is the one piece of this that really is "just wiring" once (1) and (2) exist).
4. Design decisions this task deliberately does not make: per-path refcounting/dedup across multiple subscribers at the `wscompat`/`git-gateway-service` layer (the agent already refcounts per path on its own side, but a second layer of subscriber bookkeeping is likely needed above it), reconnect/resume semantics if the underlying stream drops mid-session, and how `files.unwatch`'s existing local-no-op registration (`BUG-007`) interacts with a now-real `files.watch`.

None of steps 1–4 reuses `AttachPty`'s actual code — only its *shape* as a template. This is why the task treats it as a real gap rather than a bridging job: the wiring pattern is proven and cheap, but the thing being wired to does not exist yet in either `infra-fleet-service` or `git-gateway-service`, and building it is comparable in size to what `AttachPty`/`AttachScreencast` themselves once cost.

## What this task is NOT saying

This is not the same class of gap as `TASK-006` (agent has literally nothing) or `BUG-004`'s original `ephemeralVm` finding (no owning service, no agent primitive, no design). The hard part here — a working, tested, refcounted file-watcher with push notifications — is done and requires zero agent-side changes. The only work is backend-go transport plumbing across two services. A future implementer should start from `AttachPty`'s existing code as the literal template (message shapes, usecase structure, adapter wiring, `channels_terminal.go`'s stream-channel registration) rather than designing from scratch.

## Verify

No code changes; nothing to build or test. If this is picked up for real, its test coverage should follow the existing precedent exactly: a new `attach_pty.go`-equivalent usecase test in `infra-fleet-service`, a `channels_terminal.go`-equivalent stream-channel test in `wscompat` (mirroring `channels_terminal_test.go`'s `terminal.create` coverage), and `detect_changes()` run before committing per this repo's GitNexus convention.
