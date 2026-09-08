# BUG-015: `files.createFile`, `files.watch`, `files.browseServerDir` — genuinely unregistered, missed by both the pre-screening diff and `BUG-007`

**Service owning the first two:** `git-gateway-service` — but its `GitGatewayServiceClient` proto has no `CreateFile` RPC and no file-watch/streaming RPC at all (capability gap, not just a wiring gap). **Service owning the third:** none confirmed — `devServer.browseDir` (a different channel, `infra-fleet-service`-backed) covers the same *concept* for SSH/dev-server targets, but nothing backs it for a bare `runtime:<environmentId>` target.
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:702-919` (`registerFilesChannels` — does not register any of these three), `registry.go:195-196` (`notImplementedHandler`, what a call to any of them hits today)
**Severity:** Medium — `files.createFile` breaks a core, everyday action ("New File" in the file explorer/tab bar) for every remote/environment runtime target, with no fallback; `files.watch` silently disables live external-change notifications for remote targets (degrades to "never updates without a manual refresh," not a hard crash); `files.browseServerDir` breaks one step of the Create/Clone-Project folder picker for environment targets specifically (SSH and dev-server targets use different, working channels)
**Status:** Partially resolved 2026-09-07 — `files.createFile` is now implemented end-to-end (new `CreateFile` proto RPC/usecase/localfs+relay executor methods/gRPC wiring/`wscompat` channel registration, with unit + channel test coverage; verified via `go build`/`go vet`/`go test` for `git-gateway-service` and `api-gateway`). `files.watch` remains unimplemented — investigation found the Dev Server Agent's `fs.watch`/`fs.changed` primitive is real and already shipped, but no streaming RPC transport exists yet in `infra-fleet-service`/`git-gateway-service` to carry its push events to `wscompat`; documented as an honest blocker in `specs/backend-go/bugs/missing-v3/tasks/TASK-BUG015-files-watch-blocked-on-agent-fswatch.md` rather than force-built. `files.browseServerDir` remains unimplemented and is now cross-referenced below as the same root blocker `TASK-022` already documents (`ephemeralVm.provision` not existing) — not a separate problem.

---

## Why this wasn't caught already

`BUG-007` (this same directory) correctly closed out the pre-screening candidate's claim that 16 `files.*` methods were unregistered — all 16 turned out to be wired via the `simpleFileOp` helper, which a naive `.Register("...")` grep misses. But `BUG-007`'s own verification list (and the original `missing-v3-candidates.md` scan, and `frontend_rpc_methods.txt`) only covers the methods that scan could see as **literal string arguments to `callRuntimeRpc`**. Three real call sites don't take that shape and were missed by every prior pass in this audit:

1. `files.createFile` is produced by a **ternary expression**, not a literal string argument:
   `frontend/src/renderer/src/runtime/runtime-file-client.ts:410`:
   ```ts
   kind === 'directory' ? 'files.createDir' : 'files.createFile',
   ```
   A regex over `callRuntimeRpc\(.*'files\.` (or over `.Register("files.` on the backend side) never sees the `'files.createFile'` branch of this ternary as its own token the way a scan pattern-matching on quoted-string literals immediately after `callRuntimeRpc(target,` would.

2. `files.watch` is passed as an object property to a **different function** (`window.api.runtimeEnvironments.subscribe`), not to `callRuntimeRpc` at all:
   `frontend/src/renderer/src/runtime/runtime-file-client.ts:884`:
   ```ts
   .subscribe(
     {
       selector: target.environmentId,
       method: 'files.watch',
   ```
   A scan for `callRuntimeRpc\(.*'<namespace>\.` structurally cannot find this call site.

3. `files.browseServerDir` lives in a **separate file** (`runtime-server-directory-browser.ts`) that the original candidates scan's "16 of ~20" count didn't fully enumerate — the pre-screening doc's own Group 3 entry says "Registered/local-only ones seen so far: browseServerDir, changed, commitUpload(?), createFile(?), unwatch, watch — VERIFY," i.e. it flagged these six as uncertain and asked the assigned agent to check. This report is that check, for the three of the six (`createFile`, `watch`, `browseServerDir`) that turn out to be real, still-open gaps. (`commitUpload` and `unwatch` are registered as deliberate local no-ops per `BUG-007`; `changed` is not an RPC method at all — it is the *payload event name* the frontend's `FsChangedPayload` type uses locally, not a channel.)

Confirmed absent from `wscompat` by direct grep (not the ternary/object-property-blind regex):

```
$ grep -n '"files\.createFile"\|"files\.watch"\|"files\.browseServerDir"' backend-go/services/api-gateway/internal/adapter/wscompat/*.go
(no matches)
```

`registerFilesChannels` (`channels_git.go:702-919`) registers exactly 18 channels via `simpleFileOp`/`r.Register` — `read`, `stat`, `readDir`, `readChunk`, `readPreview`, `write`, `writeBase64`, `writeBase64Chunk`, `createDir`, `createDirNoClobber`, `delete`, `search`, `listAll`, `listMarkdownDocuments`, `rename`, `copy`, `commitUpload`, `unwatch` — confirmed by re-reading the file end to end. None of `createFile`, `watch`, `browseServerDir` are among them.

---

## `files.createFile` — capability gap, live call sites, no fallback

**Frontend call site:** `frontend/src/renderer/src/runtime/runtime-file-client.ts:395-414` (`createRuntimePath`), routed through `getRemoteFileArgs`/`getActiveRuntimeTarget` exactly like every other `files.*` method in this file — reaches backend-go whenever `target.kind === 'environment'`.

`createRuntimePath(context, path, 'file')` is called from real, everyday UI flows, not test-only code:
- `frontend/src/renderer/src/components/tab-bar/tab-create-entry-action.ts:200` — the tab bar's "New File" action
- `frontend/src/renderer/src/components/right-sidebar/useFileExplorerInlineInput.ts:154` — the file explorer's inline "new file" input
- `frontend/src/renderer/src/lib/create-untitled-markdown.ts:73` — new untitled markdown document creation
- `frontend/src/renderer/src/web/web-preload-api.ts:1741` — the web preload API's own `files.createFile` call

And has dedicated test coverage expecting this exact channel name (`frontend/src/renderer/src/runtime/runtime-file-client.test.ts:842`, `frontend/src/renderer/src/lib/create-untitled-markdown.test.ts:257`).

**No backing RPC exists at all** — this is a capability gap, not just an unwired handler, same class of finding as the original `BUG-009`:

```
$ grep -n "CreateFile\b" backend-go/proto/orca/gitgateway/v1/gitgateway.proto
(no matches — only `rpc CreateDir(CreateDirRequest) returns (CreateDirResponse);` at line 74)
```

```
$ ls backend-go/services/git-gateway-service/internal/usecase/ | grep -i create
create_dir.go
create_worktree.go
create_worktree_test.go
prefetch_create_base.go
(no create_file.go)
```

**Impact:** for any worktree hosted on a remote/environment runtime target, every "New File" action in the app fails with `channel "files.createFile" is not yet implemented in backend-go — see backend-go/docs/execution-plan.md's frontend-compatibility-layer coverage table` (`registry.go:195-196`'s exact error format). "New Folder" (`files.createDir`) works fine — only file creation is broken, which is an easy thing to miss in end-to-end testing that happens to exercise folder creation but not file creation.

## `files.watch` — capability gap, live call sites, degrades silently rather than crashing

**Frontend call site:** `frontend/src/renderer/src/runtime/runtime-file-client.ts:876-891` (`createSharedRuntimeFileWatch`), reached from `subscribeRuntimeFileChanges` (`runtime-file-client.ts:821-859`), which is called live from:
- `frontend/src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts:320` — file explorer live refresh on external fs changes
- `frontend/src/renderer/src/hooks/useEditorExternalWatch.ts:314` — the editor's "file changed on disk" reload prompt

This does not go through `callRuntimeRpc`; it goes through a separate subscription transport, `window.api.runtimeEnvironments.subscribe({selector, method: 'files.watch', params, timeoutMs})` (`runtime-file-client.ts:882-892`), which for an `'environment'` target still ultimately needs a matching **stream-capable** channel registration in `wscompat` (`RegisterStream`/`RegisterStreamChannel`, the same idiom `terminal.subscribe`/`terminal.create` use — see `BUG-008`). No such registration exists for `files.watch` under any of `Register`, `RegisterStream`, `RegisterStreamChannel`, or `RegisterBinaryStreamHandler`.

**No backing RPC exists in `git-gateway-service`'s proto either** — `gitgateway.proto` has no `Watch`/`SubscribeFileChanges`/streaming file-event RPC of any kind (confirmed against the same `rpc ` listing `BUG-007` used to enumerate the file-I/O surface).

**Impact — degrades rather than crashes:** unlike `files.createFile`, this failure is caught. `subscribeRuntimeFileChanges`'s caller awaits `shared.start`, which rejects with the channel-not-implemented error; both call sites invoke it as `void subscribeRuntimeFileChanges(...)` (fire-and-forget, not awaited), so the practical effect for a remote/environment runtime target is: **the file explorer and editor never receive live notifications of external file changes** (e.g. a file an agent's terminal session edited, or a file changed by another collaborator) — the user only sees the current state after a manual refresh (`workspace.refreshFileTree`, confirmed real per `BUG-PW-02`). This is a different, broader mechanism than `BUG-PW-02`'s "auto-refresh after agent complete" gap (which is about one specific trigger event, tracked via `BUG-PW-04`'s cross-service event bus); `files.watch`'s absence means **no** external-change source — agent-driven or otherwise — ever reaches a remote target's UI without a manual action.

## `files.browseServerDir` — narrower, one path of a three-path picker

**Frontend call site:** `frontend/src/renderer/src/runtime/runtime-server-directory-browser.ts:9-18` (`browseRuntimeServerDirectory`), called live from:
- `frontend/src/renderer/src/components/sidebar/RemoteFileBrowser.tsx:134` (`fetchListing`) — but only on the **third branch** of a three-way dispatch:
  ```ts
  const result = targetId
    ? await window.api.ssh.browseDir({ targetId, dirPath })
    : devServerId
      ? await window.api.devServer!.browseDir!({ id: devServerId, path: dirPath })
      : await browseRuntimeServerDirectory(requireRuntimeEnvironmentId(runtimeEnvironmentId), dirPath)
  ```
  i.e. SSH-target and dev-server-bound browsing use different, separately-confirmed-working channels (`window.api.ssh.browseDir` is desktop-local; `devServer.browseDir` **is** registered in `wscompat`, per the real `RelayByDevServer`-backed implementation documented at `channels.go:625` and surrounding lines). Only the bare-`environmentId` case (no SSH target, no dev-server binding) falls through to `files.browseServerDir`.
- `frontend/src/renderer/src/components/sidebar/useCreateProjectDefaults.ts:222` — resolving the default starting directory (`~`) for the Create/Clone-Project folder picker, same environment-only branch pattern.

Both are real, live call sites (confirmed by production code, not just tests) in the "Add a project → browse for a folder" flow.

**Confirmed absent from `wscompat`** — the only occurrence of the string `files.browseServerDir` anywhere in `backend-go` is a comment (`channels.go:625`, documenting that `devServer.browseDir`'s response shape intentionally matches "the shape desktop's own local `files.browseServerDir` returns" — i.e. the comment itself confirms `files.browseServerDir` is understood as a **desktop-local, Electron-IPC-only** concept in the codebase's own mental model, never a `wscompat`-registered channel to begin with).

**Impact:** for a project whose only host binding is a bare `runtime:<environmentId>` (no SSH target, no dev-server), the "Browse..." folder picker in Add/Clone Project and the default-starting-directory resolution both fail. This is narrower than the other two findings — it only affects one specific target shape in one specific flow — but it is a real, unaddressed gap since `devServer.browseDir`'s existence does not help this case (it requires a `devServerId`, which this branch by definition does not have).

**Same root blocker as `TASK-022`, not a separate, independently-solvable problem:** `files.browseServerDir` fires for exactly the "bare `runtime:<environmentId>` target with no dev-server/connection binding" case `specs/backend-go/bugs/missing-v3/tasks/TASK-022-environment-devserver-resolution-blocked-on-ephemeralvm.md` already documents as blocked on `ephemeralVm.provision` not existing yet — no backend-go service has an `environment` concept or an `environmentId -> devServerId` resolution path today (confirmed by that task's own grep of `infra-fleet-service`/`project-service` for `environment_id`/`EnvironmentID`: no matches). Until `ephemeralVm.provision` lands and gives a bare environment a real dev-server/connection binding, there is no `devServerId` for `devServer.browseDir` to key on and nothing else to build `files.browseServerDir` against — implementing a bespoke resolution path here would duplicate (and risk conflicting with) whatever `TASK-022`/`ephemeralVm.provision` eventually settles on. Do not attempt an independent fix for this method; track it against `TASK-022`'s unblock instead.

---

## Owning service

- `files.createFile` / `files.watch`: **`git-gateway-service`** is the natural owner by domain (worktree-scoped file I/O, same as every other `files.*` method), but its proto has neither RPC today — this needs new proto + usecase work, not just a wscompat wiring change, same shape as `BUG-004`'s "no owning service has this capability yet" verdict.
- `files.browseServerDir`: no owning service confirmed. `devServer.browseDir` (`infra-fleet-service`-backed, relays to the Dev Server Agent) is the closest analog but is keyed on `devServerId`, not `environmentId`, and nothing resolves the latter to the former for a connectionless runtime target — the same underlying "runtime environment has no dev-server/connection binding" gap `BUG-008` documents for `terminal.create`.

## See also

- `specs/backend-go/bugs/missing-v3/BUG-007-files-channels-false-positive-already-implemented.md` — closes out the other 18 `files.*` methods as fully implemented; this report is the narrower remainder `BUG-007` did not cover (its own text only verifies the methods the pre-screening candidates file listed, which did not include these three).
- `specs/backend-go/bugs/missing-v1/BUG-009-files-channels-not-implemented.md` — original 18-method full-namespace gap (Aug 17), already marked ✅ Resolved and confirmed stale for those 18 by `BUG-007`; this report shows the resolution was not 100% complete — `createFile`/`watch` are the same class of capability gap BUG-009 originally described, just never enumerated in its 18-method table (BUG-009's own table has no `files.createFile`/`files.watch`/`files.browseServerDir` rows — this is genuinely new ground, not a regression of something BUG-009 already flagged).
- `specs/backend-go/bugs/logic-v1/BUG-PW-02-file-explorer-dir-entry-and-auto-refresh-gaps.md` — documents the "auto-refresh after agent complete" gap as a missing event-bus trigger (see its own `BUG-PW-04` cross-reference); `files.watch`'s absence is a broader, structural version of "nothing tells the file explorer anything changed" — no trigger of any kind reaches a remote target, not just the agent-complete one. BUG-PW-02 does not mention `files.watch`, `files.createFile`, or `files.browseServerDir` anywhere in its text (confirmed by direct read) — this report does not overlap it, it extends it.
- `specs/backend-go/bugs/missing-v3/BUG-008-terminal-create-host-local-connectionless-unsupported.md` — the same "bare `runtime:<environmentId>` target has no dev-server/connection binding to hang real backend work off of" root cause recurs here for `files.browseServerDir`.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:702-919` — `registerFilesChannels`, confirmed 18 registrations, none of the three named here
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go:195-196` — `notImplementedHandler`, exact error text any of the three would surface today
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:625` — comment confirming `files.browseServerDir` is understood as desktop-local, never wscompat-registered
- `backend-go/proto/orca/gitgateway/v1/gitgateway.proto` — no `CreateFile`, no `Watch`/streaming file-event RPC
- `backend-go/services/git-gateway-service/internal/usecase/` — no `create_file.go`, no watch/subscribe usecase
- `frontend/src/renderer/src/runtime/runtime-file-client.ts:410` — `files.createFile` ternary call site
- `frontend/src/renderer/src/runtime/runtime-file-client.ts:876-892` — `files.watch` subscribe call site
- `frontend/src/renderer/src/runtime/runtime-server-directory-browser.ts:9-18` — `files.browseServerDir` call site
- `frontend/src/renderer/src/components/tab-bar/tab-create-entry-action.ts:200`, `frontend/src/renderer/src/components/right-sidebar/useFileExplorerInlineInput.ts:154`, `frontend/src/renderer/src/lib/create-untitled-markdown.ts:73`, `frontend/src/renderer/src/web/web-preload-api.ts:1741` — live `files.createFile` call sites
- `frontend/src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts:320`, `frontend/src/renderer/src/hooks/useEditorExternalWatch.ts:314` — live `files.watch` call sites (via `subscribeRuntimeFileChanges`)
- `frontend/src/renderer/src/components/sidebar/RemoteFileBrowser.tsx:100-134`, `frontend/src/renderer/src/components/sidebar/useCreateProjectDefaults.ts:222` — live `files.browseServerDir` call sites
- `/tmp/claude-1000/-opt-repos-orca/8cdf0282-e9bf-470b-97f8-c03bed6dcd57/scratchpad/missing-v3-candidates.md` — Group 3's own text flagged these six method names as "VERIFY" and uncertain; this report resolves three of them as real, open gaps
