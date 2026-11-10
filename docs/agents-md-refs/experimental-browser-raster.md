# Experimental browser raster rendering

Set `ORCA_EXPERIMENTAL_BROWSER_RASTER_SCALE=2` when launching a headless Orca host to select genuine 2× offscreen bitmap output. Values from 1 to 3 are accepted; the scale is fixed when the page is created. The default hidden-window backend is unchanged.

The screencast sizes an offscreen window in CSS pixels, preserves logical input coordinates and restores the original surface when streaming stops or the debugger detaches. Both normal and backup snapshots respect the viewer's frame budget. A 2× output contains four times as many pixels before budget downsampling, so this remains opt-in.

This applies to server-owned pages. It does not convert existing desktop webviews or establish that a locked or display-asleep desktop is supported (#11492). Default headless blank captures are tracked separately by #26138 / #26139.

## Reproduce

After installing dependencies and building workspace packages, run:

```sh
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/browser-mobile-raster/run.cjs \
  --scale 3 --output /tmp/orca-raster-candidate
```

The diagnostic launches a disposable hidden Electron process using the checkout's real browser backend and screencast implementation. It checks portrait, reload, landscape, a lower frame budget, backup screenshot capture, CSS-coordinate clicks, changing image content and surface restoration. The backup-capture case deliberately rejects `capturePage` to exercise the existing CDP screenshot route.

Use `--scale 2` for the phone's current 2× request. To run the same check against an unmodified checkout, add `--source /absolute/path/to/main`. On a 2× Mac display, the current main control satisfies the 2× request but does not supply 3× output; the 3× scenario therefore distinguishes real output-scale selection from display-dependent rendering.

The diagnostic uses the repository's Linux display-launch helper and temporary app data. The profile registry, page-dialog service and remote-admission boundaries are replaced by fixture services; no user profile, running Orca instance or pairing credentials are used. It checks real pixels and input through the low-level stream, not RPC transport, encryption, shared-viewer ownership or a physical phone.

The `offscreen-browser-raster.electron.test.ts` suite runs the same diagnostic at 3×. Captures and the JSON report stay in the requested output directory; they are synthetic and must not be committed.

Windows, Linux, real SSH hosts, physical-phone taps, display sleep, lock-screen recovery and renderer-crash restoration still need separate acceptance before enabling this by default.
