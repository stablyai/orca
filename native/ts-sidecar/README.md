# ts-sidecar

Userspace Tailscale sidecar for the Orca desktop. It joins the user's tailnet via
`tsnet` (no kernel TUN, no routing changes, coexists with other VPNs) and exposes:

- a loopback **SOCKS5 proxy** for outbound dials to tailnet SSH hosts, and
- an **NDJSON control socket** the desktop uses for status / interactive login, and
- an optional **inbound listener** (`--inbound-port`) that reverse-proxies tailnet
  connections to a loopback service (the desktop's WebSocket server).

See [`docs/tailnet-userspace-connectivity.md`](../../docs/tailnet-userspace-connectivity.md)
for the design.

## Build

```sh
# From the repo root: builds resources/-named binaries for the host platform's arches.
pnpm run build:ts-sidecar
# Or a specific target:
node config/scripts/build-ts-sidecar.mjs --platform linux --arch x64
```

Binaries are named `ts-sidecar-<node-platform>-<node-arch>[.exe]` and shipped via
electron-builder `extraResources` to `resources/ts-sidecar/`.

## Test

```sh
go test ./...          # pure unit tests (ipc, forward) — no network
```

### Live tailnet end-to-end verification

The design's inbound "done" is a second tailnet node reaching the desktop over the
tailnet. `e2e/` does exactly that with two in-process `tsnet` nodes (one stands in
for the phone), proving the Listen + reverse-proxy data path over a real tailnet —
no hardware required. It needs a **reusable, ephemeral** auth key from your tailnet:

```sh
TS_AUTHKEY=tskey-auth-... go test ./e2e/ -run TestTailnetInboundEndToEnd -v
```

Without `TS_AUTHKEY` the test skips, so it stays out of the normal suite.
