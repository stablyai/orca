# Remote Web Paste And Activity Fixes

## Problem

- Paired browser image paste reads a clipboard image in `src/renderer/src/web/web-preload-api.ts:120`, converts it to PNG base64, and sends the whole string through `clipboard.saveImageAsTempFile` at `src/renderer/src/web/web-preload-api.ts:1613`. `src/main/runtime/rpc/ws-transport.ts` sets `maxPayload` to 1 MiB, and the browser RPC client encrypts JSON requests into base64 text frames. A screenshot well below the existing 24 MiB clipboard schema limit can still exceed the encrypted WebSocket frame cap and close the socket as `Remote Orca runtime connection interrupted`.
- Paired browser workspace activity is inflated. `src/renderer/src/lib/worktree-status.ts` and `src/renderer/src/lib/worktree-activity-state.ts` currently treat any mirrored web terminal surface ID as active, even when `src/renderer/src/runtime/web-session-tabs-sync.ts` only has a pending host terminal with no ready PTY handle.

## Root Cause

- The clipboard RPC accepts up to 24 MiB of base64 in `src/main/runtime/rpc/methods/clipboard.ts`, but the web transport limit applies before the server can validate RPC params. Because the web client encrypts JSON and base64-encodes the encrypted bytes, the safe plaintext chunk is materially smaller than 1 MiB. The existing 512 KiB file-upload chunk size in `src/renderer/src/runtime/runtime-file-client.ts` is safe after JSON plus encryption expansion; a chunk close to 1 MiB is not.
- The file-upload RPCs cannot be reused directly. They write worktree-relative files and then commit a rename; clipboard paste must call `saveClipboardImageBufferAsTempFile`, return a local or SSH temp path, and preserve the terminal repo's `connectionId`.
- Web session-tab sync intentionally mirrors pending host terminal surfaces so the tab model stays in parity, but it writes `ptyIdsByTabId[mirroredTabId]` only from `status: "ready"` surfaces. The status/filter helpers then bypass that liveness map with `isWebTerminalSurfaceTabId`, so pending mirrors look active.

## Non-Goals

- Do not raise the global WebSocket `maxPayload`; it protects all runtime traffic, including pre-auth and mobile sockets.
- Do not change sidebar grouping, labels, counts, pairing flow, terminal UI, or clipboard permission UI.
- Do not change local Electron clipboard behavior or the existing one-shot RPC contract.

## Design

1. Add bounded chunked clipboard-image RPCs.
   - Keep `clipboard.saveImageAsTempFile` for small/old clients.
   - Add `clipboard.startImageUpload`, `clipboard.appendImageUploadChunk`, `clipboard.commitImageUpload`, and `clipboard.abortImageUpload`.
   - `start` takes `expectedBase64Length` and `connectionId`, rejects values over the existing 24 MiB base64 limit, records the target connection, and returns an unguessable upload ID.
   - `append` takes `uploadId`, `offset`, and `contentBase64`; reject unknown IDs, out-of-order offsets, chunks above 512 KiB, invalid base64 characters, and cumulative length beyond `expectedBase64Length`.
   - `commit` verifies the received length equals `expectedBase64Length`, validates the full base64 payload with the same rules as the one-shot RPC, calls `saveClipboardImageBufferAsTempFile` with the recorded `connectionId`, and deletes the upload state in `finally`.
   - `abort` deletes the upload state and is idempotent.
   - Bound server memory with a small max concurrent upload count and a TTL cleanup for abandoned uploads. Upload state is process-local; reconnects restart the paste instead of resuming.

2. Switch paired browser image paste to the chunked path.
   - After `navigator.clipboard.read()` and PNG conversion, return `null` for no image as today.
   - Preflight `contentBase64.length` against the 24 MiB limit before starting an upload.
   - Send 512 KiB base64 slices. This is below the 1 MiB encrypted frame cap after JSON and E2EE base64 expansion.
   - Abort best-effort on append or commit failure. If `start` returns `method_not_found`, fall back to `clipboard.saveImageAsTempFile` only when the payload is below a conservative single-frame threshold; never send a large fallback frame.

3. Tighten workspace activity liveness.
   - Treat terminal workspaces as active only when `tabHasLivePty(ptyIdsByTabId, tab.id)` is true.
   - Remove the blanket `isWebTerminalSurfaceTabId` active shortcut from `getWorktreeStatus` and `hasActiveWorkspaceActivity`.
   - Keep browser tabs active without terminals.
   - Keep fresh/retained explicit agent rows able to promote status to `permission`, `working`, or `done`; this is separate from terminal liveness.

## Data Flow

- Paste image:
  - Browser paste command -> `navigator.clipboard.read()` -> PNG base64 in web preload memory.
  - `clipboard.startImageUpload({ expectedBase64Length, connectionId })` -> upload ID.
  - Repeated `clipboard.appendImageUploadChunk({ uploadId, offset, contentBase64 })`.
  - `clipboard.commitImageUpload({ uploadId })` -> runtime saves temp image locally or on the SSH target -> terminal receives the temp path.

- Workspace activity:
  - Host `session.tabs.listAll` or subscription snapshot includes terminal surfaces.
  - Web sync mirrors tabs but writes live PTY handles only for ready surfaces.
  - Sidebar status/filter reads `ptyIdsByTabId` and browser tabs.
  - Pending mirrored terminals with no PTY remain visible but do not count as active.

## Edge Cases

- Clipboard has no image or browser lacks `navigator.clipboard.read`: return `null`, no upload session.
- Clipboard read/permission/conversion fails: existing terminal paste error path reports the failure; the runtime socket should stay open.
- Non-PNG clipboard images may grow during PNG conversion; validate the post-conversion base64 length.
- Image exceeds 24 MiB base64: reject before upload and enforce again on the server.
- Chunk boundaries must preserve base64 validity; the 512 KiB chunk size is divisible by 4, and the final full payload validation catches padding errors.
- Append retry or concurrent append with the same upload ID: offset validation rejects duplicate, skipped, or out-of-order data.
- Multiple paired browser clients or windows paste at once: upload IDs isolate sessions and the concurrent-upload cap bounds memory.
- Append or commit fails: browser aborts best-effort; server TTL cleans abandoned state.
- SSH connection missing or drops during commit: commit fails, upload state is still deleted, and the paste path reports the error.
- Runtime restarts during upload: pending RPC fails; no resume is attempted.
- Pending host terminal surface later becomes ready: the next snapshot writes PTY handles and the workspace becomes active.
- Host closes a terminal or browser tab: the next snapshot removes the mirrored tab and stale PTY/browser handles before activity is recomputed.

## Test Plan

- Unit: `src/main/runtime/rpc/methods/clipboard.test.ts` for start/append/commit/abort, offset validation, invalid base64, size limit, TTL cleanup, commit cleanup on save failure, SSH `connectionId` forwarding, and concurrent upload isolation.
- Unit: `src/renderer/src/web/web-preload-api.test.ts` for chunk sequencing, 512 KiB max chunks, `method_not_found` small-payload fallback, no large fallback frame, and abort on append/commit failure.
- Unit: `src/renderer/src/lib/worktree-status.test.ts` and `src/renderer/src/lib/worktree-activity-state.test.ts` for pending mirrored terminal inactivity, ready mirrored terminal activity, browser-only activity, and explicit agent-row promotion.
- Focused run: `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/rpc/methods/clipboard.test.ts src/renderer/src/web/web-preload-api.test.ts src/renderer/src/lib/worktree-status.test.ts src/renderer/src/lib/worktree-activity-state.test.ts`.
- Type/lint: `pnpm typecheck`, `pnpm lint`.
- Paired-client validation: restart the host app, pair a real browser client, paste a screenshot large enough that the old one-shot RPC exceeded the 1 MiB encrypted frame cap into a local terminal and an SSH-backed terminal, confirm the runtime socket stays connected, then compare browser and host sidebar activity.

## UI Quality Bar

No layout changes. The paired browser sidebar should show active dots only for workspaces with live terminal PTYs, browser tabs, or explicit agent rows. Image paste should insert the generated temp image path into the terminal without connection-error toasts or DevTools runtime disconnect errors.

## Review Screenshots

1. Paired browser sidebar after hydration with inactive Done/Todo workspaces visible but not marked active.
2. Paired browser terminal after image paste, showing the generated temp image path inserted.
3. Host sidebar for the same session, showing matching active workspace state.

## Rollout

1. Add chunked clipboard RPC implementation and tests.
2. Switch web preload image paste to chunked upload and tests.
3. Tighten activity/status liveness helpers and tests.
4. Run focused tests, typecheck, and lint.
5. Validate in a paired Electron/browser session, including SSH paste, and capture the review screenshots.

## Lightweight Eng Review

- Scope: narrow to web clipboard transport and activity liveness. No global WebSocket limit, sidebar redesign, or local Electron clipboard changes.
- Architecture/data flow: web preload owns browser clipboard read and chunk sequencing; main runtime clipboard RPC owns upload session state and final temp-file save; sidebar helpers stay pure and consume the existing live-PTY map.
- Failure modes: oversized images must fail before a large frame is sent; abandoned uploads expire; failed append/commit paths clean up; pending host terminal mirrors do not inflate activity; SSH commit failures do not leak upload state.
- Tests: cover RPC lifecycle and bounds, web preload sequencing/fallback/abort, status/filter liveness, and real paired-client paste/sidebar parity.
- Performance/blast radius: chunking is not free. A max-size image is dozens of serialized runtime RPC calls and duplicates base64 in browser and main memory. The impact is limited to image paste by TTL, size, and concurrency caps. Activity changes affect sidebar filters, jump palette activity, and status dots.
- UI quality: no new chrome. Judge only sidebar parity, paste result, and absence of runtime disconnect/toast regressions.
- Screenshots: browser sidebar, browser terminal after paste, and matching host sidebar.
- Residual risk: clipboard permission and image conversion behavior are browser-dependent, so paired browser validation is required in addition to unit tests.
