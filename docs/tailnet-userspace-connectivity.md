# Tailnet Userspace Connectivity

## Problem

Orca already talks to remote machines over two paths, and both assume the network
underneath is somebody else's job:

- **Outbound SSH.** `src/main/ssh/ssh-connection.ts` dials remote hosts with `ssh2`,
  falling back to system OpenSSH (`src/main/ssh/ssh-system-fallback.ts`). To reach a
  Tailscale machine today the user must have Tailscale installed at the OS/kernel layer
  so the `100.x` address or MagicDNS name resolves and routes.
- **Inbound mobile/web.** The desktop runs a WebSocket RPC server on `0.0.0.0:6768`
  (`src/main/runtime/rpc/ws-transport.ts`) that phones and remote browsers connect into
  after E2EE pairing (`src/shared/pairing.ts`, `mobile/src/transport/rpc-client.ts`).
  Reaching it from outside the LAN again means OS-level Tailscale, or a hand-rolled
  tunnel.

OS-level Tailscale on the **desktop** creates a kernel TUN device and rewrites the routing
table. That conflicts with other VPNs the user may run (corporate AnyConnect, WireGuard,
etc.) and requires a separate install/admin step. The desktop is the work machine — the
place where that conflict actually bites and where Orca runs as an always-on server. We
want the Orca desktop to be reachable on, and able to reach, a tailnet **without** an
OS/kernel install, and to **coexist with any other active VPN**.

The **phone** is a different situation: a personal device the user controls, where the
official Tailscale app is a one-tap install and runs in userspace
(NetworkExtension / `VpnService`) with no kernel driver to fight. So we do **not** embed
Tailscale in the mobile app. Mobile relies on the user's own Tailscale install and simply
connects to the desktop's tailnet endpoint.

## Goal

Embed Tailscale in **userspace** on the desktop so that:

1. The desktop can dial **outbound** to tailnet SSH hosts with no kernel install.
2. The desktop can accept **inbound** connections from tailnet clients (mobile, remote
   desktop) with no kernel install.
3. None of this touches the routing table, so it coexists with any other active VPN on the
   desktop.
4. The mobile app, acting purely as a **client**, reaches the desktop over the tailnet
   using the user's **own** Tailscale install on the phone — no Orca-side mobile changes
   beyond consuming a tailnet pairing endpoint.

The enabling fact is Tailscale's **userspace networking** (`tsnet`): a full tailnet node
with no TUN device. Connectivity is exposed as in-process `Dial` / `Listen` (and a local
SOCKS5 proxy) instead of an OS network interface. No TUN means nothing to fight other VPNs
over, and MagicDNS names resolve inside the library rather than via `/etc/resolver`.

## Non-goals

- No OS-level `tailscaled`, no kernel TUN, no system routing changes on the desktop.
- **No tailnet code embedded in the mobile app.** No gomobile, no `libtailscale`, no
  native module. Mobile uses the user's installed Tailscale app. Mobile is client-only and
  never `Listen`s.
- No Orca-operated control plane. Devices join the **user's own** tailnet via interactive
  login. We do not mint node keys, run a coordination server, or own ACLs.
- No change to the existing E2EE/pairing crypto. Tailnet is a transport underneath the
  unchanged tweetnacl layer.
- No replacement of the relay/multiplexer/provider stack. Tailnet only supplies the
  transport socket; everything above `config.sock` is untouched.
- No removal of LAN connectivity. The WS server keeps its `0.0.0.0` bind; tailnet is an
  additional path, not a replacement.

## Accepted tradeoff

By relying on the official Tailscale app on the phone instead of embedding, we accept that
iOS/Android allow only **one active VPN tunnel at a time**. A user who runs another
always-on mobile VPN cannot have it and Tailscale active simultaneously. Embedding
`libtailscale` in userspace would have dodged this (it does not consume the VPN slot), but
that requires a whole gomobile build pipeline for a constraint that personal-phone users
can manage themselves. The desktop, where simultaneous-VPN coexistence genuinely matters,
keeps the userspace embedding.

## Background: what the transport seam looks like today

Two existing facts make this tractable and shape the whole design.

**Outbound has a socket seam.** `ssh-connection.ts` already supports handing `ssh2` a
pre-built duplex instead of dialing TCP itself: for `ProxyCommand` it spawns a process and
sets `config.sock` (see `resolveEffectiveProxy` / `spawnProxyCommand` in
`src/main/ssh/ssh-connection-utils.ts`). A tailnet connection is the same shape — produce a
socket to `host:22`, set `config.sock`. The relay deploy
(`src/main/ssh/ssh-relay-deploy.ts`), multiplexer (`ssh-channel-multiplexer.ts`), and
PTY/fs/git providers are all transport-agnostic and need **zero** changes.

**Inbound is already URL-pluggable and tailnet-aware.** The pairing offer
(`src/shared/pairing.ts`, `mobile/src/transport/pairing.ts`) is just
`{ v, endpoint, deviceToken, publicKeyB64 }` — `endpoint` is an arbitrary `ws://` URL. And
`mobile/app.json` already whitelists Tailscale CGNAT ranges (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`) for cleartext WebSocket. The app was already designed to accept a
tailnet endpoint; the only missing piece is the desktop advertising one.

**The crypto doesn't care about the transport.** The mobile↔desktop channel is tweetnacl
box over plain `ws://` (`ws-transport.ts`, `src/renderer/src/web/web-e2ee.ts`), not TLS.
Running it over a tailnet socket needs no certs, no TLS termination, no SNI handling. The
existing E2EE and `deviceToken` allowlist (`src/main/runtime/runtime-rpc.ts`) layer
unchanged on top.

## Design

### 1. Desktop-only `tsnet` embedding

All tailnet logic lives in a single `tsnet`-based Go binary, delivered as a forked
**sidecar process** (`ts-sidecar`) that the Electron main process launches and talks to
over a Unix domain socket / named pipe — the exact pattern already used by
`src/main/daemon/*` (forked child, NDJSON framing, token-file auth). There is no mobile
embedding.

```
        ┌─────────────────────────────┐         ┌──────────────────────────┐
        │  DESKTOP (Electron main)    │         │  MOBILE (Expo RN client) │
        │                             │         │                          │
        │  ts-sidecar (Go, tsnet)     │         │  user's Tailscale app    │
        │   ├─ Dial → SOCKS5 :loop ───┼──┐      │   (OS-level, userspace)  │
        │   │   (ssh2 config.sock)    │  │      │                          │
        │   └─ Listen :6768 (tailnet) │  │      │   RN WebSocket ──────────┐
        │       └─ reverse-proxy ─────┼──┼──→ 127.0.0.1:6768 WS server    │
        │           to loopback WS    │  │      │   dials desktop tailnet  │
        │   IPC: Unix socket (daemon  │  │      │   IP/MagicDNS:6768 over   │
        │        pattern) → main      │  │      │   the phone's tailnet ◄──┘
        └─────────────────────────────┘  │      └──────────────────────────┘
                                          │
        desktop is a userspace tailnet node — no TUN, no kernel install,
        coexists with other VPNs. phone is a normal OS-level tailnet node.
```

### 2. Desktop sidecar (`ts-sidecar`)

A Go binary embedding `tsnet`, forked and supervised by the main process. Reuse the
daemon's lifecycle scaffolding (`src/main/daemon/production-launcher.ts`): fork on demand,
health-check, restart on crash, shut down on quit, token-file auth on the IPC socket.

State (the node key) persists under `~/.orca/userData/tailnet/` so the device stays the
same tailnet node across launches and does not re-auth every time.

**Why a process, not an in-process Node addon:** cgo-in-Node (N-API) adds build and crash
complexity for no benefit here. The forked-sidecar pattern is already proven in this repo,
isolates Go crashes from the main process, and matches how the daemon and computer sidecar
already work.

**IPC protocol** (NDJSON over the Unix socket, mirroring `daemon-server.ts`):

- `hello` → `{ ok, version }` with token auth.
- `status` → `{ state, tailnetIp, magicDnsName, authUrl? }`. `authUrl` is present while
  login is pending (see §5).
- `up` / `down` → start/stop the node, begin interactive login.
- `listen` config: which local port to expose on the tailnet and where to forward it.
- Event stream (second socket, role `stream`, as the daemon does): `state-changed`,
  `peers-changed`, so the renderer can show tailnet status live.

Outbound dials go through the SOCKS5 listener (§3), not an explicit RPC.

### 3. Desktop outbound (SSH to tailnet hosts)

The sidecar runs a **loopback SOCKS5 listener** (e.g. `127.0.0.1:<ephemeral>`). `tsnet`
resolves MagicDNS names server-side, so the desktop never needs local MagicDNS — it hands
the hostname to the proxy and lets the tailnet resolve it.

In `ssh-connection.ts`:

- Add a transport discriminator to `SshTarget` in `src/shared/ssh-types.ts`:
  `transport?: 'direct' | 'tailscale'` (default `'direct'`, so existing targets are
  unaffected).
- When `transport === 'tailscale'`, build `config.sock` from the SOCKS5 proxy (add the
  `socks` npm dependency: `SocksClient.createConnection` → socket → `config.sock`). This
  reuses the exact seam `ProxyCommand` already uses; `resolveEffectiveProxy` gains a
  `tailscale` branch.
- The system-OpenSSH fallback path is **not** available for tailnet targets (it would
  need OS routing). Tailnet targets always use the `ssh2` + `config.sock` path. Surface a
  clear error if the sidecar is down rather than silently falling back.

Host discovery: a picker populated from the sidecar's `peers-changed` data
(hostname → tailnet IP), so users select tailnet machines instead of typing `100.x`
addresses. Imported `~/.ssh/config` aliases keep working as `direct` targets.

### 4. Desktop inbound (accept tailnet clients)

The sidecar calls `tsnet.Listen` on the WS port and reverse-proxies each accepted
connection to the existing WS server. Per the decision to **keep the `0.0.0.0` bind**, the
WS server is unchanged; the tailnet listener is an *additional* path alongside LAN. A phone
on the LAN still pairs and connects exactly as today; a phone on the tailnet reaches the
same server through the sidecar.

The pairing QR/offer construction gains the tailnet endpoint. When the sidecar reports a
`tailnetIp` / `magicDnsName`, the pairing pane offers a "tailnet" endpoint variant
(`ws://<magic-dns>:6768`) in addition to the LAN endpoint. `deviceToken` and `publicKeyB64`
are unchanged — E2EE is identical regardless of which address the socket rode in on. **This
is the only change required to make mobile work over the tailnet.**

### 5. Authentication: user's own tailnet, interactive login

The desktop node logs in interactively to the **user's** tailnet. No auth keys in the
default flow, no Orca-run control plane. The phone authenticates separately through its own
Tailscale app — outside Orca's concern.

- The Go core surfaces an **auth URL** (`https://login.tailscale.com/...`) when the desktop
  node needs to authenticate.
- Main receives `authUrl` via the `status` RPC and opens it with `shell.openExternal`. The
  settings pane shows "connecting → waiting for login → connected" off the event stream.
- State persistence makes login a one-time-per-device event (node key under
  `~/.orca/userData/tailnet/`).

(Auth keys / OAuth-minted ephemeral nodes are a possible later option for headless or fleet
scenarios, but are out of scope for the default UX.)

### 6. Mobile (client, no embedding)

Mobile needs no native tailnet code. Given the user has the official Tailscale app
installed and active on the phone:

- The desktop pairing offer carries a tailnet endpoint (§4); the phone scans it and the
  RPC client (`mobile/src/transport/rpc-client.ts`) connects to
  `ws://<desktop-tailnet-host>:6768` like any other endpoint. Reconnect/backoff/foreground
  logic is unchanged.
- `mobile/app.json` already whitelists tailnet ranges for cleartext WebSocket, so iOS/
  Android permit the connection without further config. Verify this end to end on both
  platforms.
- Optional polish only: surface in the pairing UI that the offered endpoint is a tailnet
  address, and let the user pick LAN vs tailnet if both are advertised.

### 7. Packaging and build

- **Desktop sidecar:** build `ts-sidecar` per platform/arch (darwin x64/arm64, linux
  x64/arm64, win x64), ship via electron-builder `extraResources` + `asarUnpack`, chmod
  `0755` in `afterPack` — the same machinery already used for `agent-browser` and
  `sherpa-onnx` (`config/electron-builder.config.cjs`). macOS notarization/signing applies
  as it does to other bundled binaries.
- **No mobile build changes.** No gomobile, no vendored framework/aar, no new prebuild
  step. This removes the highest-risk pipeline from the original plan.
- Pin the Tailscale (`tsnet`) library version centrally.

## Edge Cases

- **Other VPN active on the desktop.** Userspace = no TUN, no route changes; the other VPN
  owns routing and Orca's tailnet traffic flows only through the in-process proxy/listener.
  This is the core requirement and must be verified explicitly per platform.
- **Another VPN active on the phone.** Only one mobile VPN slot exists; if it's taken by a
  non-Tailscale VPN, the tailnet path is unavailable and the phone falls back to LAN
  pairing. Documented as an accepted limitation (see "Accepted tradeoff").
- **Sidecar down on a tailnet SSH dial.** Fail with a clear "tailnet not connected" error;
  never silently fall back to system SSH (it can't route the tailnet address anyway).
- **MagicDNS.** Never resolve tailnet names on the desktop OS. Outbound passes the name to
  SOCKS5. The phone resolves via its own Tailscale install.
- **Login expiry / key rotation.** Desktop node key persists; on expiry the core
  re-surfaces an auth URL and the settings pane re-prompts. Existing reconnect logic drives
  the retry.
- **LAN and tailnet both reachable.** Pairing offers both endpoints; the client uses
  whichever it can reach. E2EE is identical, so there's no security difference between
  paths.
- **NAT / no direct path.** `tsnet` (desktop) and the phone's Tailscale app both fall back
  to DERP relays automatically; no app-level hole-punching work needed.

## Security Considerations

- The desktop joins the user's tailnet, so tailnet ACLs are an additional access-control
  layer the user already controls — on top of, not instead of, the existing `deviceToken`
  + tweetnacl E2EE.
- Keeping the WS `0.0.0.0` bind preserves today's LAN exposure surface; the tailnet path
  adds reachability without widening the bind.
- The desktop node key is a secret: stored under `~/.orca/userData/tailnet/` with
  restrictive perms, never logged, never in pairing offers.
- The sidecar IPC socket keeps the daemon's `0o600` + token-file auth model so local
  non-Orca processes can't drive the tailnet node.

## Rollout

Phased so each step ships a usable increment. Removing the mobile embedding removes the
long-pole risk; the remaining work is all desktop-side and built on existing patterns.

1. **Go core spike.** `tsnet` library with Dial + Listen + loopback SOCKS5, interactive
   login; prove a hand-rolled client reaches one tailnet host and accepts one inbound conn.
   De-risks the core before any wiring.
2. **Desktop outbound.** Fork `ts-sidecar` on the daemon pattern; SOCKS5 → `config.sock`;
   `transport` field on `SshTarget`; tailnet host picker. Ships "SSH to tailnet hosts, no
   kernel, other-VPN-safe."
3. **Desktop inbound + pairing.** `tsnet.Listen` → reverse-proxy to the WS server; pairing
   offer advertises the tailnet endpoint. Verify a phone with the official Tailscale app
   connects end to end (iOS + Android).
4. **Auth + lifecycle polish.** Interactive login UX on the desktop, node-key persistence,
   reconnect handling, tailnet status UI in settings, and the optional mobile pairing-UI
   hint for LAN-vs-tailnet endpoints.

## Open Questions

- Whether the desktop sidecar should also expose an HTTP proxy (in addition to SOCKS5) for
  any future non-SSH outbound tailnet use.
- Long-term: auth keys / OAuth-minted ephemeral nodes for headless or fleet deployment of
  the desktop node, if interactive login proves too heavy for some users.
