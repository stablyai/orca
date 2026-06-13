# Image Viewer Pinch Zoom

## Problem

- `src/renderer/src/components/editor/ImageViewer.tsx:27` stores viewer zoom and exposes toolbar zoom controls.
- `src/renderer/src/components/editor/ImageViewer.tsx:106` renders the inline image surface without a wheel handler.
- `src/renderer/src/components/editor/ImageViewer.tsx:198` renders the popup image surface without a wheel handler.
- On Chromium/Electron, trackpad pinch gestures arrive as `wheel` events with `ctrlKey: true`; the viewer does not intercept them, so users cannot pinch to zoom the image in or out.

## Root Cause

`ImageViewer` only changes zoom through button clicks. The image surfaces let ctrl-wheel events bubble/default, so pinch gestures never update `zoom` and may be consumed by Chromium-level page zoom instead. The inline surface is scrollable only in `fill` layout; in `intrinsic` layout it is `overflow-visible`, so the fix must not depend on scrollability.

## Non-goals

- Do not redesign the image viewer chrome or add new controls.
- Do not change PDF handling; `application/pdf` still delegates to `PdfViewer`.
- Do not implement pan/drag or persistent per-file zoom.
- Do not change image loading, file IPC, or SSH/runtime preview fetching.

## Design

1. Add pure zoom helpers in a concrete renderer module such as `image-viewer-zoom.ts` so the math can be tested under the repo's node-based Vitest setup:
   - `clampZoom(next)` clamps to the existing `MIN_ZOOM` and `MAX_ZOOM`.
   - `shouldHandleImageZoomWheel(eventLike)` returns true only for ctrl-wheel input.
   - `getPinchZoomFactor(deltaY, deltaMode)` normalizes pixel/line/page wheel deltas and returns a bounded multiplier; `deltaY === 0` should not change zoom.
   - `getNextWheelZoom(currentZoom, deltaY, deltaMode)` applies the factor and clamp without touching React state.
2. Add an `applyZoomChange(fn)` wrapper inside `ImageViewer` that uses functional `setZoom`, and reset `zoom` to `1` when `filePath`, `mimeType`, or `cleanedContent` changes. `EditorContent` can reuse the same `ImageViewer` component position across image files, so local zoom must not accidentally carry across file switches or external reloads.
3. Add refs for the inline image surface and popup image surface. Bind native `wheel` listeners with `{ passive: false }`, not React `onWheel`; this repo already uses native non-passive wheel listeners where Chromium default prevention must be reliable. Keep the listener callback stable enough that it is not rebound on every zoom tick.
4. The wheel handler must:
   - ignore ordinary wheel/trackpad scroll;
   - handle only `event.ctrlKey` wheel events, which Chromium/Electron uses for trackpad pinch and Ctrl+wheel zoom;
   - call `preventDefault()` and `stopPropagation()` for every handled ctrl-wheel event, including when already clamped, so browser/app zoom does not also change;
   - map negative `deltaY` to zoom in and positive `deltaY` to zoom out;
   - use the bounded delta-scaled multiplier instead of applying the full toolbar `ZOOM_STEP` once per wheel event.
5. Attach the listener to both image surfaces, not to `document` or `window`, so editor/terminal/browser panes outside the image viewer keep their existing wheel behavior. The popup listener must attach after the Radix dialog content mounts and clean up when it unmounts; a callback ref or an effect keyed by `isPopupOpen` is acceptable.
6. Keep existing toolbar buttons wired through the same clamp helper.

## Data Flow

- Trackpad pinch over image surface
- Chromium emits `WheelEvent` with `ctrlKey`
- Native non-passive `wheel` listener intercepts it
- `zoom` state updates
- Existing inline and popup image transforms render at the new scale
- Footer percent updates from `zoomPercent`
- When the rendered file changes, `zoom` resets to `1` while object URL creation/revocation stays on the existing path

## Edge Cases

- Ordinary scrolling without `ctrlKey` must still scroll the image surface.
- Pinch gestures at `MIN_ZOOM` or `MAX_ZOOM` must stay clamped.
- Ctrl-wheel at `MIN_ZOOM` or `MAX_ZOOM` must still prevent default browser zoom.
- Popup and inline surfaces within one `ImageViewer` must stay in sync because they share one `zoom` state.
- Image diff panes each mount their own `ImageViewer`; pinch over one side should only zoom that side. Do not introduce cross-pane sync in this fix.
- `layout="intrinsic"` must receive pinch events even though the inline surface is not an overflow scroller.
- Ctrl-wheel over the footer toolbar should keep existing button behavior and not become a hidden zoom target; the listener belongs on the image surface only.
- PDF previews must remain unaffected.
- The behavior must work for local and SSH-backed images because it is renderer-only after bytes are loaded.
- Windows/Linux touchpads that also surface pinch as `ctrlKey` wheel events should work without platform-specific branches.
- File switches, file reloads, external file mutations, and multi-window sessions should not add shared state: zoom remains local to the mounted viewer, resets for new loaded image content, object URL cleanup remains unchanged, and native wheel listeners must be removed on unmount/remount.
- Existing CSS transform zoom does not resize the scrollable layout box. Do not try to solve transform-origin panning or full-image scroll extents in this change; keep pinch behavior consistent with the existing toolbar zoom.

## Test Plan

- Unit tests: cover the extracted zoom helpers under the existing node Vitest config; this repo does not currently include jsdom, happy-dom, or Testing Library, so do not promise DOM component tests unless that tooling is deliberately added.
- Unit tests: assert negative/positive/zero `deltaY`, pixel/line/page `deltaMode` normalization, min/max clamping, and bounded per-event zoom factors.
- Unit tests: assert the wheel decision helper ignores non-ctrl wheel events and treats ctrl-wheel as handled even when the resulting zoom is already clamped or `deltaY` is `0`.
- Electron validation: open a PNG in Orca, dispatch a cancelable `WheelEvent` with `ctrlKey` on the inline image surface, verify the displayed percent and visual scale change, and verify an ordinary wheel still scrolls where applicable.
- Electron validation: open popup and repeat after the dialog mounts; close/reopen the popup and repeat once to catch duplicate or stale native listeners.
- Electron validation: open an image diff and verify ctrl-wheel on one pane changes only that pane's percent.
- Electron validation: switch from one image file to another or reload changed image content and verify zoom returns to `100%`.

## UI Quality Bar

Pinch zoom should feel like an existing viewer capability rather than a new UI surface: no layout shift, no new visible controls, footer percent remains stable, ordinary scrolling remains available, zoom changes are not jumpy under high-frequency trackpad events, and the popup chrome matches the current image viewer styling.

## Review Screenshots

1. Inline image viewer at default `100%`.
2. Inline image viewer after pinch zoom in, showing a higher footer percent.
3. Popup image viewer after pinch zoom out/in, showing the same percent as the inline viewer for that `ImageViewer`.
4. Image diff viewer after pinch zooming only one pane, showing the other pane unchanged.
5. Adjacent smoke state: normal editor/file surface still renders after closing the popup.

## Rollout

1. Add wheel/pinch zoom handling to `ImageViewer`.
2. Add focused tests for the pinch handler behavior.
3. Run typecheck, lint, and relevant renderer tests.
4. Validate in Electron and capture screenshots.

## Lightweight Eng Review

- Scope: kept to `ImageViewer` gesture handling and focused tests; no new viewer state model, persistence, or chrome changes.
- Architecture/data flow: renderer-only DOM wheel handling updates existing `zoom` state; no main-process, IPC, SSH, runtime, or persistence boundary changes.
- Failure modes covered:
  - ordinary wheel scroll accidentally blocked;
  - browser/app zoom also responding to pinch;
  - zoom exceeding existing min/max;
  - popup and inline surfaces diverging;
  - diff panes being accidentally synchronized;
  - native listener leaks or duplicate listeners after popup open/close;
  - stale zoom state under rapid wheel event bursts;
  - accidental zoom carryover across image file switches or external reloads;
  - PDF previews accidentally receiving image gesture behavior.
- Test coverage required:
  - node unit tests for extracted zoom math and wheel-decision helpers;
  - Electron validation for native listener default-prevention behavior, popup wheel handling, diff-pane isolation, and zoom reset on image content changes;
  - screenshot validation for inline default, inline zoomed, popup zoomed, image-diff isolation, and adjacent editor state.
- Performance/blast radius: low but not free; trackpads emit many wheel events, so the handler must do O(1) work, use functional state updates, avoid layout reads, and avoid document/window listeners. Blast radius stays inside mounted `ImageViewer` instances.
- UI quality bar: no new visible UI; existing footer percent and scrollable image surface should remain visually stable.
- Required review screenshots:
  1. Inline image viewer at `100%`.
  2. Inline image viewer after pinch-equivalent zoom in.
  3. Popup image viewer after pinch-equivalent zoom.
  4. Image diff viewer after pinch-equivalent zoom on one pane only.
  5. Editor/file surface after closing popup.
- Residual risks: automated Electron validation can dispatch cancelable ctrl-wheel DOM events against the listener, but it does not fully prove OS-level physical trackpad pinch behavior or Chromium's browser-zoom default path. A manual trackpad smoke test is still the final confidence check when hardware is available.
