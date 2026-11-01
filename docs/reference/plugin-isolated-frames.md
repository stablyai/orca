# Isolated plugin frames

Design contract for running plugin UI in isolated guests. Components (TSX) panels run in the same
guests; see [plugin-declarative-ui.md](./plugin-declarative-ui.md).

## Why

Panel and custom-editor frames are `srcdoc` iframes sharing the main window's session. CSP is the only
network barrier, so DNS prefetch and WebRTC (via a nested frame's fresh `RTCPeerConnection`) still reach the
network, and the opaque origin forces authors to inline every asset and shim workers, WASM, storage and `blob:`.

## Isolated guests (desktop)

Every plugin frame on desktop is an Electron `<webview>`:

- **Partition**: `persist:orca-plugin-<key>`, `<key>` = first 16 hex chars of `sha256(publisher.id)`. One
  session, one renderer process and one storage area per plugin.
- **Origin**: `orca-plugin-frame://<key>/<path>`, a privileged scheme (`standard`, `secure`,
  `supportFetchAPI`, `stream`) handled on that partition's session. Paths resolve inside the plugin root with
  the same containment and content-integrity checks as `readPanelEntry`; anything else is 404.
  `orca-plugin-frame://<key>/__orca/*` is reserved for files Orca ships.
- **CSP** (response header on every HTML document):
  `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:;
  worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- **Network is denied at the session**, not by CSP. "No network" means the frame itself makes no
  connections, requests or DNS lookups. The one way data leaves is a URL the person agrees to open:
  `orca.shell.openExternal` needs a click or key press, and Orca asks before opening a host this plugin
  was not allowed before (see Host APIs below).
  - `webRequest.onBeforeRequest` cancels every URL that is not `orca-plugin-frame://<key>/`, `data:`, `blob:`
    or `devtools:`.
  - `setProxy` pins a loopback proxy that drops every connection, with `<-loopback>` so loopback
    targets are proxied too, so traffic webRequest never sees (preconnect, WebRTC TURN-over-TCP) has
    nowhere to go; preconnect hints go through it and are never resolved.
  - `<link rel="dns-prefetch">` resolves on the system resolver, outside webRequest and the proxy, so
    `will-attach-webview` pins the guest renderer's `--blink-settings=dnsPrefetchingEnabled=false`
    (`PLUGIN_FRAME_GUEST_RENDERER_ARGUMENTS`), covering static, script-inserted and child-frame hints
    (`plugin-frame-guest-egress.electron.test.ts`). `X-DNS-Prefetch-Control: off`, the matching `<meta>`
    and the app-wide `dns-prefetch-disable` switch were measured and do not stop it.
- **Storage**: uninstalling a plugin clears its partition (`clearStorageData` and `clearCache`).
  - Guest `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`.
  - Permission request/check handlers deny everything, so `navigator.clipboard` reads and writes are
    refused; `document.execCommand('copy'|'cut')` works only inside a user gesture, as on any web page
    (pinned by `plugin-frame-guest-clipboard.electron.test.ts`);
    HID, serial, USB and Bluetooth choosers are cancelled.
  - `will-download` is cancelled; `setWindowOpenHandler` denies; navigation away from the plugin origin is
    cancelled.
- **Admission**: `will-attach-webview` only admits an `orca-plugin-` partition whose `src` origin matches its
  key, whose plugin is installed, enabled and consented, and whose session main has already configured
  (main configures it, proxy included, before `readPanelEntry` returns the guest URL). It force-sets the
  guest preload, `sandbox`, `contextIsolation`, `nodeIntegration: false`, `webSecurity`, no popups, and
  `disableDialogs` (`alert`/`confirm`/`prompt` do nothing in a plugin frame).
- **Bridge**: every HTML document the protocol serves starts with the same frame-API script as the iframe
  shell (`api`, `host.call/has`, `on`, `shell`, `files`, `document.get/onDidChange/applyEdit`), so the two
  cannot diverge. The guest preload only hands that script a one-shot transport (deleted before plugin code
  runs; offered only to `text/html` top documents, so an SVG or XML page Orca does not wrap never gets one)
  that caps bytes and rate in the isolated world and relays the `{orca:1, kind, …}` envelopes with
  `ipcRenderer.sendToHost('orca-plugin-frame', msg, userActivation)` / `ipcRenderer.on('orca-plugin-frame')`;
  `userActivation` is read in the isolated world, so page script cannot forge it. Why not
  `contextBridge.exposeInMainWorld('orca', …)`: it drops `error.code`/`retryable` on rejected calls and
  freezes getters such as `orca.api`, and a sandboxed preload cannot share code chunks with main. The host
  renderer uses `webview.send` and the `ipc-message` event. Envelope validation, budgets, sessions and
  capability gating are unchanged. A custom editor's declared `entry` gets the editor API; every other
  document gets the panel API.
- **Theme**: main bakes the host's current `--orca-*` tokens and `light`/`dark` class into every document it
  serves (the renderer sends its theme with each entry read), so the first paint and boot-time token reads
  match; `hello` and the `theme` event keep it current without a reload.
- **Reloads**: the guest URL carries `rev=`: the installed content hash, or for a dev folder a per-run
  counter the dev watcher bumps on each change it reports under that folder (`plugin-dev-revision.ts`;
  the tree is never hashed for this). An update or an asset-only dev edit remounts the guest.
- **Input**: Orca's window shortcuts are forwarded from a focused guest through the browser tab path, minus
  browser-page chords (address bar, find, reload, history, page zoom); a custom editor's save chord still
  rides `editor.keydown`, so it fires once. Editable fields get Orca's Cut/Copy/Paste context menu.
- **Switch (default on)**: rolling back is the constant `PLUGIN_ISOLATED_FRAMES_DEFAULT` in
  `src/main/plugins/panels/plugin-frame-isolation.ts`. `ORCA_PLUGIN_ISOLATED_FRAMES=0` turns guests off
  for one machine and `=1` on, overriding the
  `experimentalPluginIsolatedFrames` setting; all are main-process only. Off, frames use the `srcdoc` iframe
  (never offered `orca.shell`/`orca.files`), and components panels say they are not available.
- **Compatibility**: existing single-file plugins load unchanged. Browser clients (serve/web) have no
  `<webview>` and keep the `srcdoc` iframe; multi-file assets need the desktop app. With isolation on, a
  desktop guest that cannot be set up fails closed (the panel shows its load error and its session is
  revoked); the iframe is never a fallback for a setup failure. On the guest path no `srcdoc` HTML is read,
  hashed or sent over IPC; the guest's own navigation is the one integrity check per open.
- **Serving**: images, fonts and media stream from disk (one `Range: bytes=` answered with `206`, HEAD
  from `stat`), up to 32 MiB a file; a session holds at most 32 requests at once (`503` past that).
  Documents, scripts, styles, JSON, SVG and WASM are read whole (16 MiB cap). A declared HTML entry is a
  document whatever its extension. Path segments ending in a dot or space are refused.
- **Source modules**: `.ts`, `.tsx`, `.mts` and `.jsx` are read whole (1 MiB cap), digest-checked like
  any script, then transpiled with sucrase on one shared, lazily started worker thread (types stripped, automatic JSX for `orca`, lines
  kept, inline source map) and served as `text/javascript`. Relative imports are rewritten to exact
  files from the verified file list (the disk, for a dev tree); `orca` and URLs are left to the import
  map and CSP; any other bare import is served as a module that throws, naming the file and import.
  Results are cached in main by sha256 of the source, transpiler version and options. A transform
  still running after 2 s is cut short: the worker is terminated and the next file starts a fresh
  one. A file that fails or times out is served as a throwing module, and that result is cached too
  (`plugin-frame-module-transform.ts`, `plugin-source-transpile-client.ts`). A declared `.ts`/`.tsx` frame entry is served as a generated
  page whose only script is that file with `?orca-module`, which gets the JavaScript.
- **Diagnostics**: each guest's `console-message` errors and warnings (uncaught exceptions included) go to
  its plugin's log buffer with URLs reduced to plugin-relative paths, capped at 20 lines per plugin per
  10 s and 2000 characters a line (`plugin-frame-guest-diagnostics.ts`). `plugins.devInspect` (CLI
  `orca plugin dev inspect`) opens detached DevTools for live guests; headless hosts refuse it.
- **Integrity**: a navigation re-hashes the plugin tree, at most every 2 s per tree; any other request
  (including `fetch` of an `.html` file) reuses a check from the last 10 s. The hash records each file's
  digest, and documents, scripts, styles, JSON, SVG and WASM are served only if their bytes still match
  it, so a file swapped after the check is refused.

## Host APIs added for frames

No new capability; both require transient user activation in the frame and are rate-limited. The shell
checks `navigator.userActivation` first; the frame host re-checks the activation that arrived with the
message: only a guest's preload stamp counts. A srcdoc iframe shares the host window, whose activation any
keystroke in Orca sets, so iframes (browser clients) are never offered these methods and get
`not_permitted`. Main runs them only for calls from its own window over IPC, so a dialog or browser tab
never opens on another machine. A components panel's hidden guest never has activation of its own; only a
press on a stationary Orca-drawn control grants one call (see
[User gestures](./plugin-declarative-ui.md#user-gestures)).

- `orca.shell.openExternal(url)`: `http:`/`https:`/`mailto:` only, opened in the OS browser. Anything
  in the URL leaves the machine, so for an `http:`/`https:` host this plugin has not been allowed, Orca
  first shows "<Plugin> wants to open <host>" with the URL (truncated to 300 characters), Open / Cancel,
  and "Always allow <host> for this plugin". The choice is kept per plugin and host (with port) in main's
  settings (`pluginExternalHostGrants`, which the renderer cannot write) and cleared on uninstall.
  `mailto:` opens without asking: it fills a draft the person still has to send. Resolves
  `{ opened: false }` when the person cancels.
- `orca.files.saveAs({ suggestedName, mimeType, data })`: Orca shows its save dialog; the plugin never sees
  the chosen path. `data` is a string or `ArrayBuffer`, capped at 64 MiB. Resolves with
  `{ status: 'saved' }`, or `{ status: 'cancelled' }` when the person cancels. Any `mimeType` is accepted;
  the dialog filter comes from the suggested name's extension. Executable, script, installer, shortcut and
  disk-image types are refused, whether suggested or typed (`plugin-save-as-extensions.ts`, Chromium's
  dangerous download types plus `.iso .img .vhd .vhdx`, which shed the download mark when mounted). The
  written file is marked as downloaded: a `Zone.Identifier` stream with `ZoneId=3` on Windows,
  `com.apple.quarantine` on macOS; Linux has no such mark.
- Revocation reaches the side effect: each call re-checks that its plugin is still installed, enabled,
  consented and not kill-listed right before it writes, opens a tab or sends terminal input, so a save
  dialog left open while the plugin is disabled or uninstalled writes nothing. Dialogs and rate budgets bind
  to the window whose frame made the call (its WebContents travels with the IPC call).
- `orca.locale`: Orca's UI locale from `hello` (guests' `navigator.language` follows the OS).
