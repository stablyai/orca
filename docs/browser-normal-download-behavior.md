# Browser Normal Download Behavior

## Problem

The built-in browser does not behave like a normal desktop browser when a page downloads a file.

- `src/main/browser/browser-session-registry.ts:553` installs a `will-download` handler for browser sessions.
- `src/main/browser/browser-manager.ts:952` pauses every download before Orca has a save path.
- `src/renderer/src/components/browser-pane/BrowserPane.tsx:4915` shows a `Save` / `Cancel` prompt instead of starting the download.
- `src/main/ipc/browser.ts:342` opens a native save dialog after the renderer clicks `Save`.
- `src/main/browser/browser-manager.ts:1026` calls `DownloadItem.setSavePath()` only after that renderer + dialog round trip.
- Electron's installed type contract says `setSavePath()` is only available during the session `will-download` callback (`node_modules/electron/electron.d.ts:8271`).

That late path assignment explains the "clicked Save, still did not save" failure mode and makes the flow higher-friction than Chrome/Safari/Edge defaults.

## Root Cause

Orca treats downloads as renderer-approved actions. Electron treats the destination as a main-process `will-download` decision. The current flow crosses that boundary too late: it pauses the download, asks the renderer to approve it, asks the OS where to save it, and only then sets the save path.

## Goal

Make built-in browser downloads feel like a normal browser:

- Download starts automatically.
- File saves to the OS Downloads directory by default.
- Name collisions are resolved without overwriting.
- Browser chrome shows progress and completion.
- Completed downloads offer familiar actions such as opening or revealing the file.
- Cancel remains available while downloading.

## Non-goals

- A full persistent download manager/history.
- A settings UI for "ask where to save every file."
- Cross-device transfer of downloads from a remote browser host to a local client.
- Changing generic filesystem downloads outside the browser.

## Design

1. **Resolve the save path synchronously in main**

   Add a small browser-specific destination module, e.g. `src/main/browser/browser-download-destination.ts`, that:

   - uses `app.getPath('downloads')`;
   - normalizes the filename to a safe basename;
   - uses `path.join` for cross-platform paths;
   - avoids overwrites with browser-style suffixes (`report.csv`, `report (1).csv`);
   - checks existing files synchronously because Electron requires `setSavePath()` during `will-download`;
   - also checks a main-process reservation set for active browser downloads, so two same-name downloads that start before either file exists still get distinct paths;
   - keys reservations by a normalized absolute path, with platform-aware case folding where the target filesystem is conventionally case-insensitive, so `Report.csv` and `report.csv` cannot collide on Windows;
   - caps suffix attempts and fails the download with a clear error instead of spinning forever in a crowded Downloads directory.

   Do not create a placeholder file just to reserve the path: Electron may treat an existing target as an overwrite. The in-memory reservation prevents Orca-internal concurrent collisions; an external process can still create the same path after the check, so this remains best-effort at the filesystem boundary.

2. **Set the destination during `will-download`**

   In `BrowserManager.handleGuestWillDownload`, compute and reserve the path, then call `DownloadItem.setSavePath()` immediately while still in the `will-download` call stack. Do not pause for renderer approval, do not open `dialog.showSaveDialog`, and do not use `setSaveDialogOptions()` for this flow because that still preserves dialog behavior. If destination resolution or `setSavePath()` fails, release the reservation, cancel the item, and send or queue a failed terminal event with a specific, non-secret error.

3. **Track downloads from start to finish in main**

   Replace the approval-centric state with browser download state:

   - `downloading`: save path is already assigned; item is progressing, waiting on network, or temporarily interrupted.
   - `completed` / `failed` / `canceled`: terminal states sent to the renderer.

   Register `updated` and `done` listeners immediately in `will-download`, store latest received-byte count plus any terminal result, and keep the existing guest-to-tab queue so downloads that start before registration still surface when the tab binds. Queue state snapshots, not every progress event: if a download finishes before the tab registers, flush a started row followed by its terminal state so the renderer does not drop an orphan progress/finish event. If an unregistered guest is destroyed or retired before the tab binds, cancel its queued active downloads and release their reservations instead of only dropping the pending queue entry. Send exactly one terminal event per download, detach only this feature's listener references during cleanup, and release the reserved path on every terminal path and on explicit cancel.

4. **Update IPC shape for browser-like status**

   Keep the existing renderer event channels if that keeps the diff smaller, but change the payload contract from "approval requested" to "download started" semantics. Include `browserPageId` on start/progress/finish when the tab is known, include `savePath` on start and terminal data, and keep progress payloads to `downloadId`, byte counts, and transient state. Remove the renderer `acceptDownload` path for normal browser downloads and delete the save-dialog IPC test; `cancelDownload` remains useful while an item is active.

5. **Render browser chrome, not an approval prompt**

   In `BrowserPane`, replace the `Save` / `Cancel` prompt with a compact download row/list under the toolbar:

   - active row: filename, origin, progress label, `Cancel`;
   - completed row: filename, "Downloaded" status, `Open`, `Show`, dismiss;
   - failed/canceled row: filename, concise failure/cancel reason, dismiss.

   Track more than one download per pane so a second download does not hide the first. Cap visible recent completed rows to a small number, such as three, to avoid growing the browser surface. This is a per-pane transient list, not persisted history.

6. **Use existing shell bridges for actions**

   Use `window.api.shell.openFilePath(savePath)` for `Open` and `window.api.shell.openInFileManager(savePath)` for `Show`. `openPath` is a legacy reveal wrapper whose `void` return type prevents the preload bridge from reporting success or failure back to the renderer. If either action fails or the file has been moved/deleted, show an inline or toast failure that does not claim the file opened.

## Data Flow

```text
Browser session will-download
  -> BrowserManager computes and reserves ~/Downloads/name.ext
  -> DownloadItem.setSavePath(path) during will-download
  -> BrowserManager tracks item and sends/queues browser download-started
  -> BrowserPane renders progress row
  -> DownloadItem updated/done
  -> BrowserManager sends progress/finished
  -> BrowserPane shows completed row with Open / Show
```

## Edge Cases

- Duplicate filenames must not overwrite existing files.
- Simultaneous same-name downloads in the same Orca process must not choose the same path before either file exists.
- Same-name reservation checks must respect platform path identity, including case-insensitive collisions on Windows.
- External filesystem races between path selection and Chromium's file creation are unavoidable with `setSavePath()`; treat them as residual risk, not a guarantee.
- Path traversal or separator-like filenames must collapse to a safe basename.
- Empty filenames fall back to `download`.
- Unknown total bytes should show received bytes or a generic "Downloading" state without broken math.
- Multiple simultaneous downloads from the same tab must render independently.
- A download that starts, progresses, or finishes before the webview registers must still appear once the tab binds.
- A queued download whose guest is destroyed or retired before registration must be canceled and release its reserved path.
- Since this design intentionally avoids a global persistent download manager, closing the owning browser tab must cancel active downloads rather than leaving hidden file writes with no chrome.
- `setSavePath()` failure should not leave a hidden, still-running download.
- `updated` events with `interrupted` state should keep the row honest without treating them as terminal; `done` is the terminal source of truth.
- Explicit cancel and Electron's eventual `done` callback must not produce duplicate terminal UI events.
- Completed file actions may fail if the file was moved/deleted after download; UI must report that honestly.
- On Windows, Linux, and macOS, all paths are built with Node/Electron path APIs.
- In SSH/remote workflows, the file is saved on the machine running the browser runtime; UI copy must not imply cross-machine transfer.
- Web clients keep their existing "handled by server browser" behavior unless the server-side browser implements equivalent events.

## Test Plan

- Unit: destination builder sanitizes names, preserves extensions, picks collision-free paths, respects active path reservations including platform path identity, releases reservations, and stops at a bounded suffix limit.
- Unit: `BrowserManager.handleGuestWillDownload` calls `setSavePath()` during handling, does not pause/resume for approval, registers listeners immediately, sends started/progress/finished events exactly once, and cancels cleanly on destination failure.
- Unit: queued download-started/progress/finished state flushes after guest registration with the latest state.
- Unit: multiple download events for one browser page are tracked independently.
- Unit: guest cleanup cancels queued-but-unbound active downloads and releases reserved paths.
- Unit: tab unregister cancels every active download for that tab and releases reserved paths.
- IPC: remove `browser:acceptDownload` and its native save-dialog test for normal downloads; keep `browser:cancelDownload` authorization coverage.
- Renderer: download list state covers active, completed, failed, canceled, unknown-size, multiple same-tab downloads, bounded recent rows, and missing-file action failures.
- Shell IPC/preload: `Open` uses `openFilePath`; `Show` uses `openInFileManager` and surfaces structured failure.
- Electron validation: from a local test page, click a download link and verify a file appears in the OS Downloads folder without a save dialog.

## UI Quality Bar

The changed browser chrome should be quiet and dense, matching the toolbar area around it. Use existing tokens (`background`, `foreground`, `muted-foreground`, `border`, `accent`) and shadcn `Button` variants/sizes. Do not use amber warning color for ordinary downloads. The active state should be readable without looking like an error. Buttons must not wrap, overlap, or resize the toolbar/pane unexpectedly. Copy must describe real state only: "Downloading", "Downloaded", "Canceled", or the specific failure.

## Review Screenshots

Stage 5 must capture:

1. Active download in progress, with no save prompt visible.
2. Completed download row with file actions visible.
3. A repeat download of the same filename showing successful completion without overwrite.
4. Multiple browser downloads visible at once or in the recent-download cap.
5. Adjacent browser toolbar smoke state after the download row is dismissed.

## Rollout

1. Add the destination builder and focused tests.
2. Move BrowserManager download handling to immediate save-path assignment and progress tracking.
3. Update browser IPC/preload/API types to remove approval semantics and carry save-path/status data.
4. Refresh BrowserPane state and UI for active/recent downloads.
5. Add renderer notices, tests, and localization catalog entries as required.
6. Run targeted unit tests, typecheck, lint, then Electron validation with screenshots.

## Lightweight Eng Review

- Scope: Kept to local built-in browser download behavior. Reduced by excluding a preferences UI, persistent download history, and remote-to-local transfer. The smallest useful normal-browser behavior is automatic save to Downloads plus transient progress/completion chrome.
- Architecture/data flow: Main owns destination choice and file writes because Electron requires `setSavePath()` during `will-download`. Renderer owns only display and user actions (`Cancel`, `Open`, `Show`, dismiss). Existing session policy installation remains the entry point; existing shell bridges handle file actions. Browser web clients remain unchanged.
- Failure modes covered:
  - Late `setSavePath()` is removed by assigning the path synchronously in `will-download`.
  - Duplicate filenames use existing-file checks plus active path reservations instead of overwriting each other inside Orca.
  - Unsafe or empty filenames are normalized before `path.join`.
  - Downloads starting or finishing before tab registration are snapshotted and flushed in order.
  - Queued downloads are canceled if their guest is destroyed or retired before registration.
  - Multiple downloads no longer overwrite a single pane state.
  - Tab close/app shutdown cancels active items rather than leaving hidden downloads without chrome.
  - File action failures after external deletion are surfaced without overclaiming.
- Test coverage required:
  - Unit: `src/main/browser/browser-download-destination.test.ts` for basename/suffix/collision/reservation behavior and bounded failure.
  - Unit: `src/main/browser/browser-manager.test.ts` for immediate `setSavePath`, listener registration, queued snapshots, progress/finish, cancellation, path-reservation release, and failure.
  - Unit/IPC: `src/main/ipc/browser.test.ts` removes the native save-dialog accept path and keeps cancel authorization.
  - Renderer: focused tests around download notice/list state if an existing seam is available; otherwise cover formatting helpers and rely on Electron validation for BrowserPane DOM behavior.
  - Electron: local server download verifies file creation in Downloads without save dialog.
- Performance/blast radius: No startup cost. Per-download synchronous filesystem checks are bounded by the collision limit and happen only during `will-download`; this is acceptable for one user action but must not walk unbounded directories. Renderer IPC volume stays proportional to Electron download progress events already emitted. No migration.
- UI quality bar: Validation should judge a neutral browser-toolbar-adjacent download row/list against `docs/STYLEGUIDE.md`: no amber error styling for ordinary progress, compact button sizes, no overlap/wrapping, honest copy, clear active/completed/failed hierarchy, and stable layout while progress changes.
- Required review screenshots:
  1. Active download in progress with no save prompt.
  2. Completed download row with `Open` / `Show` actions.
  3. Repeat same-name download completed with distinct filename.
  4. Multiple downloads visible or capped as designed.
  5. Browser toolbar after dismissing download chrome.
- Residual risks: Headless Electron may not reliably prove absence of a native save dialog; validation should instead verify no Orca `Save` prompt appears and the file lands in Downloads. If the OS Downloads path is redirected or unavailable, behavior depends on Electron's `app.getPath('downloads')` result.
