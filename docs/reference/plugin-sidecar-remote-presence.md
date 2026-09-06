# Plugin sidecar / remote presence

Host-mediated path for a plugin worker on the **runtime host** to publish a
generic sidecar frame (Discord Rich Presence is the first consumer) so a
**paired UI machine** can apply it. Complements the plugin HTTP companion; it
does not replace or delete that concept.

Design spike: `docs/superpowers/specs/2026-09-05-host-mediated-remote-presence-sidecar-design.md`.
Tracks [jondmarien/orca-discord-presence#10](https://github.com/jondmarien/orca-discord-presence/issues/10) Orca-5.

## Where things run (Windows UI → Linux host)

| Concern | Machine | Notes |
|---|---|---|
| Plugin worker + `pluginApi` host calls | Runtime host (`orca serve` or server desktop) | Already true; this API does not move plugins to the UI |
| Discord / Vesktop IPC (named pipe or UNIX socket) | The machine that has Discord | The host cannot open the other OS’s IPC |
| Sidecar mailbox + `sidecar.clientHost.latest` | Host stores; paired Electron client pulls | Authenticated runtime RPC; no extra HTTP companion |
| Plugin HTTP companion (PR #6) | Process on the Discord machine | Still valid whenever local IPC failed and no UI executor is running |
| SSH relay | Does **not** run Orca plugins | Out of scope; execution-only |

The host **does not know** whether Discord is installed on the host, the UI
laptop, both, or neither. Placement therefore never claims “Discord is here.”

## What the host forwards

`sidecar.publish` stores a JSON snapshot:

- `channel`: `presence` or `generic`
- `op`: `set` or `clear`
- `payload`: JSON, at most 8192 UTF-8 bytes of `JSON.stringify` (required on `set`, forbidden on `clear`)

The host forwards **sidecar frames only**. It does not forward:

- raw Discord IPC bytes
- companion HTTP
- plugin secrets or storage

Delivery in this spike is `stored`. A client that advertised `sidecar.clientHost.v1`
pulls with `sidecar.clientHost.latest`. A later executor on the UI machine should
apply the frame to Discord IPC. `applySidecarFrameOnUiMachine` is that insertion
point; it currently returns `discordIpc: 'not-implemented'`.

## pluginApi 1

Additive inside major 1 (`since: '1.1'`):

- Capability `sidecar` (worker only; `panel: false`)
- `sidecar.resolvePlacement`
- `sidecar.publish`

Old plugins that omit the capability are unchanged. Consent copy is honest: the
plugin may publish frames a paired UI client can apply on the Discord machine.

## Plugin decision tree

1. Keep trying **local** Discord IPC (colocated Discord on the host).
2. Call `sidecar.publish` so a paired UI executor can apply the same activity.
3. If local IPC failed and no client executor is running, keep the **companion**.

Do not dual-publish to Discord (local IPC and companion, or local IPC and a
future native executor) for the same activity.

## Wire compatibility

- New optional RPC method; no `RUNTIME_PROTOCOL_VERSION` bump.
- Host advertises `sidecar.clientHost.v1` in `RUNTIME_CAPABILITIES`.
- Electron paired clients advertise it in `ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES`.
- CLI / native generic clients and mobile do not advertise it; the method is
  not on the mobile allowlist.
- If the caller sent `clientCapabilities`, the host refuses the pull unless
  that list includes `sidecar.clientHost.v1`.

See [remote-wire-compatibility.md](./remote-wire-compatibility.md).

## Follow-ups

1. Electron client Discord IPC executor that consumes the mailbox.
2. Negotiated `sidecar.clientHost.subscribe` push (same pattern as notifications).
3. Route desktop `window.api.plugins.*` to the active remote runtime (existing gap).
4. `chron0.discord-presence` prefers the mailbox when a client executor is present.
5. Optional client attach / `capableClientCount` once an executor leases.
