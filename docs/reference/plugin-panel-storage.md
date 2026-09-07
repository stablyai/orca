# Plugin panel storage

Sandboxed plugin panels may call `storage.get`, `storage.set`, `storage.delete`,
and `storage.keys` over the existing postMessage bridge. The verbs are unchanged:
a worker writes a diagnostics ring-buffer or UI snapshot, and the plugin's own
panel reads it without a new host action, a CSP hole, or a remount.

`settings.*` is also panel-callable (plugin-private). `secrets.*` stays
worker-only.

## Privacy

- The panel never supplies plugin identity. Main binds `pluginId` from the
  opaque session issued when that panel was loaded.
- `storage.*` is `scope: 'plugin-private'`. Each plugin has its own
  `storage.json` under `plugins-data/<publisher>.<id>/`. A panel cannot name
  another plugin, and a caller-supplied `pluginId` is rejected as
  `invalid_request`.
- Missing or stale consent, or a manifest without `storage`, still returns
  `consent_required` / `capability_denied` — same gate as the worker path.
- Do not store secrets or tokens in `storage.*`. Use `secrets.*` from the
  worker. Panel results are posted back into an opaque-origin iframe (`*`).

## Message budget

Panel traffic is metered **per plugin**, not per iframe session:

| Limit                     | Value                                      | Where                      |
| ------------------------- | ------------------------------------------ | -------------------------- |
| Request / result envelope | `PANEL_MESSAGE_MAX_BYTES` (64 KiB)         | `plugin-panel-bridge.ts`   |
| Rate                      | 30 messages / 10 s                         | `PANEL_MESSAGE_RATE_LIMIT` |
| Worker storage value      | `PLUGIN_STORAGE_VALUE_MAX_BYTES` (256 KiB) | `plugin-host-api.ts`       |

An oversized **request** (typical `storage.set`) is refused before the host
method runs. An oversized **result** (a worker-written value that a panel
`storage.get` would echo) is refused with the same
`invalid_request` / `panel message exceeds the size limit` so a 256 KiB worker
blob cannot be dumped into the iframe.

Keep panel-facing snapshots — log rings, status cards — under 64 KiB. The
worker may keep larger keys for itself; the panel cannot fetch them in one
call.

## Remote / SSH

No new RPC opcode. Desktop `plugins.panelAction` and relay
`plugins.hostCall.panel` already carry `{ method, params }`. Enabling
`storage.*` on the existing panel method is additive (`pluginApi` major 1).
An older host still answers `panel_forbidden`. Storage files live on the
**execution host**, not the UI machine.

## Smoke-test (fork build + Hello Orca)

Hello Orca already declares `storage` and the worker increments a `pings` key
on **Hello: Ping**.

1. Point `devPluginPaths` at `examples/plugins/hello-orca` on a fork build
   that includes this change. Approve the plugin (include `storage`).
2. Open the Hello Orca sidebar panel. In the iframe console:

   ```js
   parent.postMessage(
     {
       type: 'orca-panel-action',
       requestId: 's1',
       action: 'storage.get',
       params: { key: 'pings' }
     },
     '*'
   )
   ```

3. Run **Hello: Ping** from the command palette, then repeat the `storage.get`.
   The panel should see the incremented count without remounting the tab.
4. Write a snapshot from the panel, then read it back:

   ```js
   parent.postMessage(
     {
       type: 'orca-panel-action',
       requestId: 's2',
       action: 'storage.set',
       params: { key: 'diagnostics.snapshot', value: { lines: ['ok'], updatedAt: Date.now() } }
     },
     '*'
   )
   parent.postMessage(
     {
       type: 'orca-panel-action',
       requestId: 's3',
       action: 'storage.get',
       params: { key: 'diagnostics.snapshot' }
     },
     '*'
   )
   ```

5. Confirm a second plugin's panel `storage.get` for the same key returns
   `{ value: null }`. Confirm `secrets.get` still returns `panel_forbidden`.
