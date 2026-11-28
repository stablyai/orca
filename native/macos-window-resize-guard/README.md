# macOS window border resize cursor guard

On macOS 26/27, AppKit's resizable border hit zone extends only ~2-3 pt inside the window frame
and ~4 pt outside (`-4..+3 pt`, plus ~16 pt rounded corner arcs). Because Orca's main window uses
`titleBarStyle: 'hiddenInset'`, Chromium's `RenderWidgetHostViewCocoa` spans `{0, 0, width, height}`
flush with all four edges and corners:

1. `-[RenderWidgetHostViewCocoa resetCursorRects]` registers `[self visibleRect]` across pixel `0`,
   overlapping the interior resize band.
2. `-[RenderWidgetHostViewCocoa shouldChangeCurrentCursor]` checks only `[self bounds]`, so mouse
   moves and cursor updates inside the 0-3 pt resize band replace AppKit's resize cursor with the
   page cursor.
3. `-[RenderWidgetHostViewCocoa mouseEvent:]` calls `[[NSCursor arrowCursor] set]` unconditionally
   on `NSEventTypeMouseExited`, resetting the cursor as the pointer moves from the content area
   outward into the `-4..0 pt` exterior resize margin.
4. `-[NativeWidgetMacNSWindow cursorUpdate:]` applies the delegate cursor over the full content
   frame without checking AppKit's resize edge region.

This N-API addon preserves Chromium's behavior across the interior content area while excluding
AppKit's live window resize region (`-[NSWindow _resizeDirectionForMouseLocation:] != -1` and a
4 pt edge / corner cursor-rect margin for resizable, non-fullscreen windows). Remove this workaround
once upstream Chromium/Electron excludes window resize regions from cursor updates on macOS.

To run the standalone AppKit verification probe without focusing a window:

```sh
clang -fobjc-arc -framework AppKit native/macos-window-resize-guard/probe-window-resize-guard.m -o /tmp/orca-resize-guard-probe
/tmp/orca-resize-guard-probe
/tmp/orca-resize-guard-probe out/native/orca_window_resize_guard.node
```
