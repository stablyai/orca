# Experimental browser raster rendering

This opt-in experiment changes only the headless `orca serve` browser backend. The desktop webview backend remains unchanged. Leave `ORCA_EXPERIMENTAL_BROWSER_RASTER_SCALE` unset to retain the existing hidden-window backend.

Set `ORCA_EXPERIMENTAL_BROWSER_RASTER_SCALE=2` for the current mobile pane's DPR2 request. Values from 1 to 3 select an actual offscreen drawing scale, not a bitmap resize. The scale is fixed at page creation; it does **not** dynamically follow every client's DPR. Multiple viewers, unrestricted DPR1 budgets, other scales and display-off recovery still require broader acceptance before making this the default.

The screencast controller sizes offscreen surfaces in CSS pixels and restores their original content size on teardown. JPEG/PNG pixels can therefore be denser while input coordinates and `deviceWidth`/`deviceHeight` remain logical. Existing frame budgets can still downsample the raster.

## Safety

Use a disposable HOME, user-data directory, project folder and port. Set `ORCA_BACKGROUND_LAUNCH=1`; never reveal or focus test windows. Do not point a development launch at the installed app's data or replace the installed app. Pairing readiness files contain credentials: keep them private and do not commit them.

## Regression runner

After building the main and CLI bundles, launch an isolated background serve runtime and save its JSON readiness privately. Run:

```sh
node tests/tools/browser-mobile-raster/run.cjs \
  --user-data "$TEST_ROOT/user-data" \
  --ready "$TEST_ROOT/ready.json" \
  --output "$TEST_ROOT/results" \
  --project-root "$TEST_ROOT/project"
```

The runner uses real `browser.screencast` frames, decodes JPEG dimensions, and checks portrait/landscape density, refresh/reconnect, changing frames, a trusted CSS-coordinate click, frame-budget downsampling, and bounded unsubscribe. It closes its page/profile. The supplied project must be disposable; its repo registration remains for inspection.

Protocol acceptance is not a claim that a physical phone is clear, that its tap mapping has passed, or that a locked/display-off host is fully supported. Test those separately before adoption.
