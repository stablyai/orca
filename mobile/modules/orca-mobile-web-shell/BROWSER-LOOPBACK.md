# Android browser loopback prerequisite

This opt-in host API has no production caller and does not change the sealed HTML
shell, guest permissions, placement, credentials, host admission, or reconnect.
`AndroidBrowserProxyRoute` retains one `MobileBrowserTunnelConnection` and one
listener for its caller's existing lease/execution-route authority, across all
SOCKS peers. The module currently permits **one active route**, with at most 32
accepted sockets; future multi-route integration needs explicit aggregate ownership.
The caller closes the route on lease or native lifecycle loss (or aborts its signal).
Transport closure also retires the listener. The module closes native resources on
`OnDestroy`. This is not a mobile lease manager or foreground/suspension policy.

The native listener binds only numeric `127.0.0.1` on an ephemeral port. It accepts
loopback connections; it never dials or resolves a destination. The portable
SOCKS parser is extracted unchanged from the desktop implementation, also used by
the Android routing experiment. Only CONNECT/no-auth is supported. The target
passes to the existing tunnel; the caller's attach authority selects native/SSH/WSL
execution, never the page URL. There is no direct-egress fallback.

## Byte ownership and flow

- Native accept/read/write are pull operations, not data events. There is one
  pending accept and at most one pending read and write per socket. A worker pool
  has at most 65 threads and 65 queued operations (one accept plus one read/write
  per peer). The queue bridges completed callbacks whose worker has not returned;
  queued operations retain their existing per-operation ownership. Core and maximum
  pool sizes both equal 65 so blocking operations grow the pool before queueing;
  no threads are prestarted and all idle threads expire after 30 seconds.
  Disposal cancels and removes obsolete queued operations, settles pending callbacks,
  and attempts every descriptor close even if another close throws.
- Read and write chunks are at most 16 KiB. Socket buffer sizes are requested at
  16 KiB; these are OS hints, not measured Android kernel memory ceilings.
  Handshake retention is at most a 262-byte partial header plus one native chunk;
  each pending handshake/open has a ten-second deadline.
- Expo 55's `ByteArrayFrontendConverter` copies the exact `Uint8Array` view into
  owned JVM storage before asynchronous work. `JNIToJSIConverter.createUint8Array`
  copies a returned byte array into a new JS buffer. No base64, borrowed JS
  backing storage on workers, whole-frame backing-buffer conversion, or streaming
  event queue is used. The private TypeScript caller always slices writes to
  16 KiB before conversion; Kotlin checks the copied argument size too. This API
  is privileged and must never be exposed to document JavaScript.
- The socket adapter awaits the core's `writeBytes` callback before the next
  native read. It returns false from `pushBytes`, writes one frame in bounded
  slices, and only then calls `consumeReadBytes` and `requestRead`. The core keeps
  framing, credit, queue limits and supplied application-budget ownership.
- Null is output shutdown, ordered after all preceding writes. `readableEnded`
  becomes true only when shutdown completes. It also handles EOF received before
  the native socket is bound and late end-listener registration. Input EOF sends
  the existing half-close and does not stop the response direction.

The supplied application budget covers core/physical transport allocations.
Native/JNI transient copies are bounded by socket/chunk counts, not registered as
extra dynamic claims in that budget. Device kernel buffers, thread-stack cost,
aggregate native WebSocket memory, and multi-route/process budgets must be measured
and integrated before production admission.

## Verification and integration boundary

The module compiles against installed Expo/RN dependencies. Its JVM tests use real
loopback sockets and cover bytes, half-close, read/write exclusion, chunk/socket
caps, blocked writes, and disposal of blocked accept/read/write. Mobile tests
exercise every split of IPv4/domain/IPv6 handshakes and the real portable core's
credit/EOF lifecycle. A Node topology test connects the Android JS adapter through
the production tunnel session to a real TCP destination; it is not an Android
Expo bridge or production authorization test. Route tests use an injected native
interface and fixture-owned RPC replies.

The transport base lacks the separately reviewed #22815/#22819 and consumed-EOF
amendment `0d1bb8d977`. This adapter exposes the required consumed `readableEnded`
property structurally; it does not copy those lower fixes. Integrate those changes
before enabling a native guest. No device/emulator, full JNI roundtrip, SSH/WSL
journey, production relay cell, or real production mobile grant is proven here.

From a generated Android project (`pnpm --dir mobile exec expo prebuild --platform
android --no-install`), run `:orca-mobile-web-shell:testDebugUnitTest` with Gradle.
Use `ORCA_BACKGROUND_LAUNCH=1` for all tests. The TypeScript commands are registered
in `browser-network-tunnel.bounded-fail-closed-route`.
