# @orca/expo-iroh usage

Dumb byte-message pipe over Iroh. JS supplies opaque E2EE frames; native only
frames them (4-byte big-endian u32 length + payload, max 1 MiB) on a single
long-lived bi-stream per connection.

**ALPN:** `orca-mobile-rpc/1`  
**Platforms:** iOS (IrohLib 1.1.0). Android methods reject with
`iroh_android_not_implemented`.

## Install (already wired in mobile/)

```json
"@orca/expo-iroh": "file:./packages/expo-iroh"
```

Requires a **dev client** rebuild after adding the package. First `pod install`
runs the podspec `prepare_command` to fetch IrohLib 1.1.0 into `ios/Vendor/`
(xcframework + UniFFI Swift bindings; gitignored).

## API

```ts
import {
  irohStart,
  irohConnect,
  irohSend,
  irohPathInfo,
  irohClose,
  irohStop,
  onIrohMessage,
  onIrohPathChanged,
  onIrohClosed
} from '@orca/expo-iroh'

// 1. Bind local endpoint (idempotent)
const { endpointId } = await irohStart()

// 2. Dial desktop by its 64-hex EndpointId
const { connectionId } = await irohConnect(desktopEndpointId)

// 3. Events
const unsubMsg = onIrohMessage(({ connectionId, bytesBase64 }) => {
  // decode base64 → existing E2EE frame handler
})
const unsubPath = onIrohPathChanged(({ pathType, detail }) => {
  // 'direct' | 'relayed' | 'mixed' | 'unknown'
})
const unsubClosed = onIrohClosed(({ connectionId, reason }) => {
  // reconnect logic
})

// 4. Send opaque payload (base64 of raw bytes)
await irohSend(connectionId, Buffer.from(frame).toString('base64'))

// 5. Optional path snapshot (polls paths(); never watchPaths — iroh-ffi#277)
const { pathType, detail } = await irohPathInfo(connectionId)

// 6. Teardown
await irohClose(connectionId)
await irohStop()
unsubMsg.remove()
unsubPath.remove()
unsubClosed.remove()
```

## How to try it (end-to-end)

Iroh is **on by default** on both ends — there is no experimental flag.
`ORCA_DISABLE_IROH=1` on desktop is the emergency kill switch (also set globally
in vitest so tests never open real UDP).

1. **Pair:** in desktop Settings → Mobile pick the **Iroh** connection option and
   generate the QR. Iroh-mode offers carry `iroh: { endpointId, relayUrl?,
   directAddresses? }` and no relay block; local-only offers never carry iroh.
2. **Phone (iOS dev client):** scan. The pairing handshake itself dials iroh
   (no ws attempt); the ws dial is used only when the native module is absent.
3. **Connections:** iroh-paired hosts dial **only** iroh — iroh discovers LAN
   paths itself and upgrades relay→direct. Cards show “Iroh attempting…” /
   “Iroh failed: …” while off-connected.
4. **Liveness:** shared `status.get` probe (~20s) on iroh (desktop idle reap 30s).

## Troubleshooting

Filter device logs with **`[iroh]`** (rpc_open / endpoint_started /
irohConnect_ok / path_changed / session_closed / rpc_open_module_unavailable).

| Symptom | Check |
| --- | --- |
| Pairing dials `ws://…` instead of iroh | The QR was not an Iroh-mode offer — re-generate with the Iroh option selected (and desktop must not run with `ORCA_DISABLE_IROH=1`) |
| `rpc_open_module_unavailable` / `native_module_unavailable` | Need custom dev client with ExpoIroh (not Expo Go); rebuild app |
| All paths fail immediately on **cellular only** | **iOS Wireless Data gate:** Settings → Orca → **Wireless Data** → **WLAN & Cellular**. Newly installed apps can be Cellular-off; the OS blocks *all* sockets and we cannot detect it reliably. Immediate “network unreachable” on LAN + iroh is a strong hint. |
| Connected but path stays `relayed` | Hole punching can take a few seconds; check `path_changed` events — NAT type may force relay permanently |

## Notes

- Path updates emit ~every 2s only when the snapshot changes. Do **not** call
  `Connection.watchPaths` — it panics off-Tokio (iroh-ffi#277).
- Module does no auth; transport layer owns pairing/E2EE.
- Android methods reject with `iroh_android_not_implemented` (compile stub only).
