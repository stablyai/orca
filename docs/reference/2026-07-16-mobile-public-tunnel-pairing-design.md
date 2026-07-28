# Mobile public-tunnel pairing

## Summary

Orca's runtime and mobile client already accept WebSocket endpoints, including
`wss://` endpoints. The desktop Mobile pairing picker is the remaining gap: it
only accepts an IP address, hostname, or `host:port`, so it cannot advertise a
TLS-terminated public tunnel without falling back to the runtime's `ws://`
scheme.

This change lets Mobile pairing accept a strict `ws://` or `wss://` endpoint in
addition to the existing address forms. It treats Cloudflare Tunnel and similar
services as user-managed direct connectivity. It does not add a Cloudflare
transport, manage tunnel processes, or carry Cloudflare Access credentials.

## Current state

The runtime owns the transport and security contract:

- `resolvePairingEndpoint` already preserves a complete `ws://` or `wss://`
  override.
- Pairing offers already carry the endpoint, a device token, and the runtime's
  pinned public key.
- Mobile opens the advertised endpoint and completes Orca's E2EE handshake
  before authenticated RPC traffic.
- Orca Relay remains an additive fallback and races the direct endpoint during
  pairing when Relay is enabled.

The renderer has two different input grammars. Runtime sharing accepts a full
WebSocket URL, while Mobile pairing uses `parseManualNetworkAddress`, which is
limited to an IP address, hostname, or `host:port`. Entering
`orca.example.com:443` therefore produces `ws://orca.example.com:443`, not the
`wss://orca.example.com` endpoint required by a public TLS tunnel.

## Decision

Add a shared `parseMobilePairingEndpoint` validator and use it in the Mobile
pairing address picker.

The validator accepts:

- the existing IPv4, hostname, and `host:port` forms;
- `ws://host[:port]` and `wss://host[:port]`.

It rejects credentials, paths, query strings, fragments, whitespace, invalid
ports, IPv6, and URL host coercions that the bare-address validator already
rejects. Restricting the first public-tunnel slice to an origin keeps the saved
Mobile endpoint grammar aligned with the Mobile host editor.

The endpoint remains a string in the existing pairing-offer version. This is an
input-surface change, not a protocol migration.

## Ownership boundaries

Orca owns:

- validating the endpoint it advertises;
- preserving the endpoint in the pairing offer;
- device-token authorization, public-key pinning, E2EE, reconnect, and
  diagnostics;
- tests proving a secure public endpoint reaches the Mobile WebSocket client.

The tunnel operator owns:

- installing and updating the connector;
- DNS, certificates, tunnel configuration, availability, and billing;
- deciding whether the hostname is public or reachable through a private
  Cloudflare One/WARP route.

This change does not:

- invoke Cloudflare APIs or persist Cloudflare API tokens;
- install, spawn, or supervise `cloudflared`;
- add Cloudflare-specific endpoint kinds to shared transport types;
- support Cloudflare Access browser cookies or service-token headers;
- change Orca Relay selection, credentials, or E2EE framing.

Cloudflare Access requires a separate design because the current Mobile client
constructs `new WebSocket(endpoint)` without an authentication cookie or custom
headers. A long-lived Access service token must not be added to the pairing URL
without explicit storage, rotation, revocation, and exposure analysis.

Publishing the endpoint also makes the WebSocket handshake Internet-reachable.
The existing runtime caps direct WebSocket connections at 128, terminates
connections that do not authenticate within 10 seconds, and still requires the
device token plus the pinned-key E2EE handshake. This limits idle unauthenticated
resource use but does not make the public hostname undiscoverable or replace
provider-side traffic controls.

## User flow

1. The operator configures a tunnel hostname that forwards WebSocket upgrades
   to the Orca runtime port.
2. In Mobile pairing, the operator chooses **Add custom endpoint…** and enters a
   value such as `wss://orca.example.com`.
3. Orca generates the existing mobile-scoped pairing QR with that endpoint.
4. The phone scans the QR and authenticates through the existing direct pairing
   path. If Orca Relay is enabled, the existing direct-versus-Relay race remains
   unchanged.

The operator-facing Cloudflare route, port mapping, Access limitation, and
verification steps live in
[Mobile pairing through a public tunnel](./mobile-public-tunnel.md).

## Verification

The first implementation must prove:

- parser acceptance for existing address forms and secure WebSocket origins;
- rejection of credentials, paths, query strings, fragments, invalid ports,
  coercive numeric hosts, and unsupported schemes;
- Mobile picker submission of the exact `wss://` endpoint;
- Mobile pairing submission of that endpoint to the direct RPC client;
- Mobile RPC construction of a WebSocket with that endpoint unchanged;
- runtime pairing-offer preservation of the secure endpoint;
- Mobile host editing preservation of an unchanged implicit `wss://` port;
- no changes to pairing scope, device token, pinned key, or Relay metadata;
- root and Mobile typecheck, lint, formatting, and focused tests.

Physical-device validation for the public Tunnel path was completed on a
physical Android device over cellular on 2026-07-16; the pairing flow reached
the E2EE-ready state and the desktop showed the paired device. iOS coverage,
connector-restart recovery, and private WARP routing remain unverified. The
private WARP path over an insecure `ws://` endpoint also needs a separate iOS
ATS check because the current exceptions are scoped to local networking and
Tailscale ranges.

## Follow-up

Connection-path labels currently distinguish only LAN, Tailscale, and Orca
Relay. A later provider-neutral change can represent a public secure direct
endpoint without labeling it as LAN. That change should remain separate from
endpoint acceptance so it can define persistence and migration semantics
without expanding this pairing-input slice.

## Local review outcome

The implementation review found one cross-flow defect before handoff: a paired
`wss://host` endpoint uses the implicit port 443, but the Mobile host editor
previously treated a missing saved port as 6768. A name-only edit could
therefore rewrite the endpoint and force a failed reconnect. The fix now
preserves an unchanged endpoint exactly and uses the current WebSocket scheme's
effective port when the hostname changes. This logic lives in
`mobile/src/transport/host-endpoint-edit.ts` so the existing endpoint parser
stays below the Mobile max-lines limit.

Local evidence on 2026-07-16:

- focused root tests: 59 passed;
- complete root test suite passed;
- complete Mobile tests: 1,771 passed and 2 skipped;
- root and Mobile typechecks passed;
- root and Mobile lint passed;
- root build passed; `build:unpack` reached the Electron download step but was
  stopped because the uncached download was not completing at a practical rate;
- Mobile and touched-root formatting passed;
- localization catalog, localization coverage, reliability manifest, and
  max-lines ratchet checks passed.

No blocking code-review findings remain. A physical Android connection over a
real public tunnel is verified by the attached PR evidence; iOS, connector
restart recovery, and private WARP routing remain unverified.
