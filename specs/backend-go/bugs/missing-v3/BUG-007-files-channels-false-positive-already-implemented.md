# BUG-007: `files.*` (16 methods) — NOT a gap; pre-screening false positive, channels are fully implemented

**Service:** `git-gateway-service` (owns all file I/O via `GitGatewayServiceClient`), wired through `api-gateway`'s `wscompat` registry
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:702-919` (`registerFilesChannels`), called live from `channels.go:159`
**Severity:** N/A — no gap found
**Status:** ❌ Not reproducible / false positive — closing this candidate, no fix needed
**Symptom (claimed, not observed):** The pre-screening candidates file (`missing-v3-candidates.md`) claimed 16 of 18 `files.*` methods (`copy`, `createDir`, `createDirNoClobber`, `delete`, `listAll`, `listMarkdownDocuments`, `read`, `readChunk`, `readDir`, `readPreview`, `rename`, `search`, `stat`, `write`, `writeBase64`, `writeBase64Chunk`) are unregistered in backend-go's wscompat channel registry. This is incorrect.

---

## What I was asked to verify

Per the audit brief, `files.*` was flagged as "likely the biggest gap in this whole audit" — 16 methods called by the frontend with a dynamic/environment-capable target, but allegedly absent from `wscompat`'s registered-channel list (confirmed via a grep over `.Register("..."` patterns across 309 channels).

## Why the candidate was wrong

The candidates file's ground-truth grep was:

```
grep -rhoE '\.Register\("[a-zA-Z0-9_.]+"' backend-go/services/api-gateway/internal/adapter/wscompat/*.go \
  | sed -E 's/\.Register\("//; s/"$//' | sort -u
```

This pattern only matches literal `.Register("channel.name"` call sites. It structurally misses two other registration idioms this package actually uses:

1. **`simpleFileOp(r, "files.X", handler)`** — a local helper in `channels_git.go` that wraps `r.Register(...)` internally. All 16 "missing" `files.*` methods are registered through this helper, not a direct `.Register(` call, so the naive grep skipped every one of them.
2. Separately (relevant to my other assigned item, `terminal.create`) — `r.RegisterStreamChannel("terminal.create", ...)` and `r.RegisterBinaryStreamHandler(...)` are also missed by a `\.Register\(` regex, because `RegisterStreamChannel(`/`RegisterBinaryStreamHandler(` are different identifiers, not `Register(`.

Re-running a corrected grep that also matches `simpleFileOp(r, "..."` and `r.Register(Stream|BinaryStreamHandler)?\(` confirms **all 18** `files.*` methods (the 16 flagged + `commitUpload`/`unwatch`, which the candidates file's own methodology had already correctly found registered) are present:

```
$ grep -rhoE '(r\.Register[A-Za-z]*\(|simpleFileOp\(r, )"[a-zA-Z0-9_.]+"' --include='*.go' \
    backend-go/services/api-gateway/internal/adapter/wscompat/ \
  | grep -oE '"[a-zA-Z0-9_.]+"' | tr -d '"' | sort -u | grep '^files\.'
files.commitUpload
files.copy
files.createDir
files.createDirNoClobber
files.delete
files.listAll
files.listMarkdownDocuments
files.read
files.readChunk
files.readDir
files.readPreview
files.rename
files.search
files.stat
files.unwatch
files.write
files.writeBase64
files.writeBase64Chunk
```

And `registerFilesChannels` is live in the real dispatch path, not dead code:

```
$ grep -n 'registerFilesChannels(' backend-go/services/api-gateway/internal/adapter/wscompat/channels.go
159:	registerFilesChannels(r, gitClient)
```

## What backend-go actually has (verified this pass)

- Every one of the 18 `files.*` handlers in `channels_git.go:702-919` calls a real `gitgatewayv1.GitGatewayServiceClient` RPC (`ReadFile`, `StatFile`, `ReadDir`, `ReadFileChunk`, `ReadFilePreview`, `WriteFile` [shared by `write`/`writeBase64` via an encoding flag], `WriteFileChunk`, `CreateDir` [shared by `createDir`/`createDirNoClobber`], `DeleteFile`, `SearchFiles`, `ListAllFiles`, `ListMarkdownDocuments`, `RenameFile`, `CopyFile`); `commitUpload`/`unwatch` are deliberate always-local no-ops (`channels_git.go:914-918`), matching the old backend's own design (see BUG-009 below).
- `git-gateway-service/internal/usecase/` has a real, non-stub usecase file for every one of these operations: `read_file.go`, `read_file_chunk.go`, `read_file_preview.go`, `read_dir.go`, `write_file.go`, `write_file_chunk.go`, `create_dir.go`, `delete_file.go`, `search_files.go`, `list_all_files.go`, `list_markdown_documents.go`, `rename_file.go`, `copy_file.go`, `stat_file.go`. No `TODO`/`not implemented`/hardcoded-return markers were found in any of these files.
- Each usecase dispatches through `ConnectionResolver` to either a **local** `FilesystemExecutor` (direct host fs I/O, `internal/adapter/localgit` presumably) or a **relay** `FilesystemExecutor` (`backend-go/services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go:939-1086`, relaying to the Dev Server Agent's `fs.*` methods over `infra-fleet-service`'s `Relay`/`RelayByDevServer` RPC) — this is the same dynamic local/relay dispatch model the frontend's old TS backend used, reproduced deliberately (`relay_executor.go`'s own package doc comments cite BUG-009 by name as the design constraint being preserved).
- The three known old-backend limitations BUG-009 flagged as "carry forward, don't re-litigate as new bugs" are preserved intentionally, not accidentally dropped:
  - `files.rename`/`files.copy` unsupported over relay — `relay_executor.go:945-949`: "`RelayExecutor` deliberately does NOT implement `usecase.LocalOnlyFilesystemExecutor` (Rename/Copy) — the agent's `fs.*` surface has no rename/copy method (BUG-009)".
  - `files.readChunk` unsupported for any remote target by design — `git-gateway-service/internal/usecase/read_file_chunk.go:8-12`, `ErrChunkedReadNotSupportedRemote`, explicitly citing "BUG-009's known-gap finding... Preserved deliberately, not a TODO."
  - `files.commitUpload`/`files.unwatch` always-local bookkeeping, no fs I/O — `channels_git.go:914-918`.
- Frontend routing is confirmed dynamic/environment-capable as claimed: `runtime-file-client.ts` calls `getActiveRuntimeTarget(settings)` and only short-circuits to local when `target.kind !== 'environment'` (e.g. lines 144-157, 496-524) — otherwise it goes through `callRuntimeRpc`, which for an `'environment'` target reaches backend-go.

## Relationship to prior reports

- **`specs/backend-go/bugs/missing-v1/BUG-009-files-channels-not-implemented.md`** — described an **18/18 full-namespace gap** (Aug snapshot): no service exposed file read/write/stat RPCs at all, `git-gateway-service`'s proto only had git plumbing (status/diff/commit/push/pull/generateCommitMessage). **This is now fully resolved** — `gitgateway.proto` has grown a complete file-I/O RPC surface (`ReadFile`, `StatFile`, `ReadDir`, `ReadFileChunk`, `ReadFilePreview`, `WriteFile`, `WriteFileChunk`, `CreateDir`, `DeleteFile`, `SearchFiles`, `ListAllFiles`, `ListMarkdownDocuments`, `RenameFile`, `CopyFile`), and every method is wired end-to-end through `wscompat` to a real usecase. BUG-009's own `**Status:**` line already says "✅ Resolved — see TASK-049–060", which this pass independently corroborates against current code — treat BUG-009 as closed, not as still-open.
- **`specs/backend-go/bugs/logic-v1/BUG-PW-02-file-explorer-dir-entry-and-auto-refresh-gaps.md`** — already documented this exact resolved state (all 18 `files.*` registered, real usecases, `registerFilesChannels` live at `channels.go:117` in that report's line numbering — now `channels.go:159`, the file has grown since) and explicitly warned: "BUG-009... is now stale/resolved for all 18 methods and should not be re-reported as a full-namespace gap." **This audit pass re-triggered exactly the warning BUG-PW-02 gave** — the `missing-v3-candidates.md` pre-screening regenerated the stale finding via an incomplete grep. This report exists to close that loop explicitly and prevent a third recurrence.
- BUG-PW-02's own remaining findings (no `size_bytes` in `ReadDirRequest`/`DirEntry`; no `depth`/`includeDotFiles`/`sortBy`/`foldersFirst` on directory listing; no server-side "agent complete" event to drive file-tree auto-refresh) are real, narrower, already-tracked gaps that this report does not duplicate — see that document for citations. They are UX/shape gaps on top of a working `files.*` surface, not evidence the namespace itself is missing.

**Verdict: this candidate is a false positive. No code fix is needed. The only action item is procedural** — the audit tooling that produces `missing-v3-candidates.md`-style ground-truth snapshots should match `simpleFileOp(r, "..."`, `r.RegisterStreamChannel("..."`, and `r.RegisterBinaryStreamHandler("..."` in addition to `r.Register("..."`, or it will keep re-flagging already-resolved namespaces that happen to use a registration helper.

---

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_git.go:702-919` — `registerFilesChannels`, all 18 `files.*` registrations via `simpleFileOp`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:159` — confirms `registerFilesChannels` is live in `RegisterRealChannels`
- `backend-go/services/git-gateway-service/internal/usecase/{read_file,read_file_chunk,read_file_preview,read_dir,write_file,write_file_chunk,create_dir,delete_file,search_files,list_all_files,list_markdown_documents,rename_file,copy_file,stat_file}.go` — real usecases, no stubs found
- `backend-go/services/git-gateway-service/internal/adapter/grpcclient/relay_executor.go:939-1086` — relay-side `FilesystemExecutor`, deliberately preserving BUG-009's documented rename/copy/chunked-read limitations
- `frontend/src/renderer/src/runtime/runtime-file-client.ts:144-157,496-524` — confirms dynamic/environment-capable target routing
- `specs/backend-go/bugs/missing-v1/BUG-009-files-channels-not-implemented.md` — predecessor, superseded/resolved
- `specs/backend-go/bugs/logic-v1/BUG-PW-02-file-explorer-dir-entry-and-auto-refresh-gaps.md` — predecessor, already documented this exact resolved state and its own smaller residual gaps
- `/tmp/claude-1000/-opt-repos-orca/8cdf0282-e9bf-470b-97f8-c03bed6dcd57/scratchpad/missing-v3-candidates.md` — the pre-screening candidate this report closes out (its grep methodology is the root cause of the false positive)
