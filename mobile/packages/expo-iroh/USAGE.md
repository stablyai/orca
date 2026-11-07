# @orca/expo-iroh usage

Dumb byte-message pipe over Iroh. JS supplies opaque E2EE frames; native only
frames them (4-byte big-endian u32 length + payload) on a single long-lived
bi-stream per connection.

The bounded wire payload cap is **8,388,690 bytes**: the larger of an 8 MiB
binary RPC frame plus 82 E2EEv2 bytes, or base64 of a 4 MiB JSON reply plus
82 bytes (5,592,516 bytes). E2EEv1 adds only 40 bytes (24-byte nonce + 16-byte
MAC); v2 also authenticates a 42-byte header. Text is base64 on the wire;
binary is not. Expo's bridge base64 is decoded before framing and does not
inflate this wire cap. The desktop keeps its **1 MiB pre-authentication**
payload cap until E2EE authenticates the socket; its 128-connection admission
limit and authentication deadline are unchanged.

**ALPN:** `orca-mobile-rpc/1`  
**Platforms:** iOS (IrohLib 1.1.0) and Android (official iroh-android 1.2.0 AAR).

## Install (already wired in mobile/)

```json
"@orca/expo-iroh": "file:./packages/expo-iroh"
```

Requires a **dev client** rebuild after adding the package. The podspec runs
`ios/install-bindings.sh` during evaluation, including local CocoaPods `:path`
installs, to fetch IrohLib 1.1.0 into `ios/Vendor/` (gitignored). Cached Swift
bindings and the retained xcframework archive are SHA-256 checked on every
invocation; the framework is re-extracted from that verified archive.
Android resolves the version-pinned AAR from Maven Central during the native
Gradle build; no repository-reviewed artifact checksum is enforced on Android.
Rebuild the native app after native module changes; updating JavaScript alone is not enough.

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

// 1. Bind local endpoint (idempotent for the same home relay)
const { endpointId } = await irohStart(null) // required nullable argument: SDK defaults

// 2. Register events before dialing: native close events can precede the connect result.
const unsubMsg = onIrohMessage(({ connectionId, bytesBase64 }) => {
  // decode base64 → existing E2EE frame handler
})
const unsubPath = onIrohPathChanged(({ pathType, detail }) => {
  // 'direct' | 'relayed' | 'mixed' | 'unknown'
})
const unsubClosed = onIrohClosed(({ connectionId, reason }) => {
  // reconnect logic
})

// 3. Dial desktop by its 64-hex EndpointId
const { connectionId } = await irohConnect(desktopEndpointId)

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
2. **Phone (iOS or Android native build):** scan. The pairing handshake itself
   uses the native Iroh module. Builds without that module reject Iroh-only
   offers safely; only legacy offers with a real WebSocket endpoint can fall back.
3. **Connections:** iroh-paired hosts dial **only** iroh — iroh discovers LAN
   paths itself and upgrades relay→direct. Cards show “Iroh attempting…” /
   “Iroh failed: …” while off-connected.
4. **Liveness:** shared `status.get` probe (~20s) on iroh (desktop idle reap 30s).

## Troubleshooting

Filter device logs with **`[iroh]`** (rpc_open / endpoint_started /
irohConnect_ok / path_changed / session_closed / rpc_open_module_unavailable).

Shared transport open/close and connect-timeout diagnostics cover both WebSocket
and native Iroh connections. A connect timeout means the transport did not become
ready before its deadline; it does not establish a WebSocket, LAN, or Iroh relay
failure. Use the native `[iroh]` events to identify the connection stage reached.

Direct Iroh paths use QUIC over UDP. Current public Iroh relays carry that traffic
over WSS; they do not offer the old raw-TCP relay transport. See upstream
[removal of the legacy relay path](https://github.com/n0-computer/iroh/pull/3384).
An HTTPS response or WebSocket upgrade proves only that the relay front end is
reachable, not that peer traffic or Orca's E2EE handshake succeeds.

`relayHintHost` is the saved pairing hint, not proof of the selected path. Use
`path_changed` for the active relay/direct path. An E2EE timeout after
`irohConnect_ok` is a later failure than a native connection timeout.

After authentication, the desktop idle lease tracks nonempty native reads
(including partial frames) and completed native write chunks. Queued or blocked
writes do not renew it. Unauthenticated traffic never extends the fixed
pre-authentication deadline.

Qualified desktop SDK natives enforce a ten-second incoming handshake deadline.
They close the timed-out native connection before releasing its admission slot;
other connections are not reset and late handshakes cannot be published.
Stock npm natives are rejected before binding. For source development, run
`node config/scripts/orcad-distribution/prebuilds/stage-source-iroh.mjs` on the
matching host before entering the pinned FHS environment.

Only authenticated direct WebSocket clients contribute TCP source-address history.
Iroh paths and home-relay addresses do not. At startup, `orca serve` can use
remembered direct public sources to allow public WebSocket clients unless
`--refuse-public` is set. Iroh admission and credential permissions remain separate.

Endpoint identity read failures leave the existing secret untouched; diagnostics
distinguish read, write, and SDK-load failures without including secret contents.
Desktop pairing codes expire after ten minutes. Visible QR codes renew without
revoking a code being scanned; changing the advertised address requires rotation.

Pairing hints require HTTPS relay origins and IP socket addresses. Invalid saved
hints fail before native startup/dial without deleting the desktop; rescan a
refreshed QR to replace them. The Desktops row refreshes Iroh hints as attempts
progress.

| Symptom                                                     | Check                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing dials `ws://…` instead of iroh                      | The QR was not an Iroh-mode offer — re-generate with the Iroh option selected (and desktop must not run with `ORCA_DISABLE_IROH=1`)                                                                                                                            |
| `rpc_open_module_unavailable` / `native_module_unavailable` | Need custom dev client with ExpoIroh (not Expo Go); rebuild app                                                                                                                                                                                                |
| All paths fail immediately on **cellular only**             | **iOS Wireless Data gate:** Settings → Orca → **Wireless Data** → **WLAN & Cellular**. Newly installed apps can be Cellular-off; the OS blocks _all_ sockets and we cannot detect it reliably. Immediate “network unreachable” on LAN + iroh is a strong hint. |
| Connected but path stays `relayed`                          | Hole punching can take a few seconds; check `path_changed` events — NAT type may force relay permanently                                                                                                                                                       |

## Relay selection

Choose **Settings → Mobile → Iroh home relay** on desktop, or the mobile Home
**Settings** tab → **Iroh relay**. Each device saves its own local home-relay
preference; the control remains available offline or when Iroh is unavailable.
Options are **Automatic** (stored as `null`, SDK defaults), **Europe**,
**US East**, **US West**, **Asia / Singapore**, and **Custom**.

`irohStart(homeRelayUrl)` requires `null` for Automatic or a canonical HTTPS
origin, for example `irohStart('https://aps1-1.relay.n0.iroh.link./')`.
Custom origins must have no credentials, path, query, or fragment.
Existing Android installs need one native APK upgrade for this API; later
preference changes do not require rebuilding.

Changing the preference reconnects only Iroh, leaving WebSocket and OrcaRelay
connections unchanged. Desktop refreshes its displayed QR without unpairing
devices or rotating pairing credentials. The remote desktop relay hint saved in
a phone's pairing profile is separate from the phone's home relay. If that old
hint is blocked, rescan the refreshed desktop Iroh QR.

Direct/LAN paths remain enabled; choosing a relay does not guarantee reachability
or change certificate checks or E2EE. Automatic uses the SDK's default relays;
a selected region or custom origin replaces them rather than adding public-relay
fallbacks. See [Phone relay settings](../../README.md#iroh-transport-and-phone-relay).

## Notes

- Path updates emit ~every 2s only when the snapshot changes. Do **not** call
  `Connection.watchPaths` — it panics off-Tokio (iroh-ffi#277).
- Module does no auth; transport layer owns pairing/E2EE.
- Android binds before relay readiness so QR direct-address hints can work on an offline LAN.
- Android releases its endpoint when the default network changes or is lost.
  The next connection binds a fresh endpoint instead of reusing DNS/network state
  from the previous Wi-Fi or cellular network.
- Native module destruction fences new work and shuts down its endpoint and
  connections on both platforms. In-flight native dial/bind futures must return
  before their owned results can be consumed and disposed.
- There is no Android foreground service guaranteeing connectivity while backgrounded.
