# Plugin panel host API

Sandboxed plugin panels (`contributes.panels`) talk to the host over a
`postMessage` bridge. This page is the privacy and budget contract for that
surface. The method table in `src/shared/plugins/plugin-host-api.ts` is the
source of truth; `PLUGIN_PANEL_ACTIONS` is derived from each spec's `panel`
flag.

## Opaque-origin iframe

The panel document is loaded as a `srcdoc` iframe with `sandbox="allow-scripts"`.
Its origin is opaque (`null`). Neither side can use `event.origin` for trust:

- The host matches `event.source` to the mounted iframe's `contentWindow`.
- Replies use `postMessage(..., '*')` because an opaque origin never matches a
  concrete `targetOrigin`.
- The guest never sees a plugin id. Main issues an opaque session token while
  loading one approved panel and binds identity again on every action.

CSP stays `connect-src 'none'` (see `PLUGIN_PANEL_CSP`). Panels cannot fetch
the network, `plugin.log`, or another plugin's files.

## Panel-callable methods (pluginApi 1)

| Method                  | Capability           | Notes                            |
| ----------------------- | -------------------- | -------------------------------- |
| `workspace.readContext` | `workspace:read`     | Focused worktree projection only. `focusedSurface` only with `ui:focus` |
| `ui.readFocus`          | `ui:focus`           | `{ focusedSurface }` poll; pluginApi 1.2. See [plugin-ui-focus.md](./plugin-ui-focus.md) |
| `terminal.sendText`     | `terminal:send`      | Explicit terminal id             |
| `notifications.show`    | `notifications:show` | Labeled with the plugin name     |
| `settings.get`          | `settings:own`       | Own `settings.json` only         |
| `settings.set`          | `settings:own`       | Own `settings.json` only         |
| `storage.get`           | `storage`            | Own `storage.json` only; see [plugin-panel-storage.md](./plugin-panel-storage.md) |
| `storage.set`           | `storage`            | Own `storage.json` only          |
| `storage.delete`        | `storage`            | Own `storage.json` only          |
| `storage.keys`          | `storage`            | Own `storage.json` only          |

Worker-only (panel calls return `panel_forbidden`): `secrets.*`,
`events.subscribe`, `sidecar.*`. Those stay out of the panel surface so an
XSS'd iframe cannot dump the plugin vault, subscribe to host events, or
publish sidecar frames.

Mixed versions: an older host still answers `panel_forbidden` for settings
or storage. A newer host accepting them over the existing
`plugins:panelAction` / `plugins.hostCall.panel` RPCs is additive — no new
stream opcode.

## Settings privacy

`settings.get` / `settings.set` are `scope: 'plugin-private'`. Handlers
receive the qualified plugin key from the authenticated session, then read or
write `<userData>/plugins-data/<publisher>.<id>/settings.json`. A panel cannot
pass another plugin's id: extra keys fail `panelActionCallSchema` as
`invalid_request`, and the store path never interpolates caller input.

Missing or stale consent is `consent_required`. A panel without
`settings:own` is `capability_denied`. Cross-plugin reads and writes are not
a capability check — they are impossible because the host never takes a
plugin id from the guest.

## Message budget

Every panel action — including settings — spends the per-plugin budget in
`src/shared/plugins/plugin-panel-message-budget.ts` before schema parse:

- Size: `PANEL_MESSAGE_MAX_BYTES` (64 KiB). Oversized → `invalid_request`.
- Rate: `PANEL_MESSAGE_RATE_LIMIT` (30 messages / 10s). Excess → `rate_limited`.
- Budget is per qualified plugin key, shared across that plugin's panel
  sessions on one transport boundary.
- Malformed and oversized frames still spend the rate window.

The renderer watchdog has a separate reserved liveness lane for pongs
(`PANEL_CONTROL_MESSAGE_MAX_BYTES`). Settings payloads never use that lane.

A settings value that fits the panel budget is still capped by
`PLUGIN_STORAGE_VALUE_MAX_BYTES` / `PLUGIN_STORAGE_TOTAL_MAX_BYTES` in the
KV store. For panels, the 64 KiB request cap is the tighter write bound.

## Smoke test

1. Enable the plugin system and load `examples/plugins/hello-orca` via
   Settings → Plugins → Development (`devPluginPaths`) or a local-path install.
2. Consent includes **Read and change the plugin's own settings**.
3. Open the **Hello Orca** right-sidebar panel.
4. Click **Load settings** (empty object on first run), then **Save greeting**
   and **Load settings** again — the greeting persists across panel remounts.
5. A second plugin's panel cannot read or write this file. `secrets.*` and
   `events.subscribe` from the panel still fail with `panel_forbidden`.
