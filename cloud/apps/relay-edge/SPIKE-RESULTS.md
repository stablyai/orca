# Relay edge local spike: results (2026-11-04)

Run: `npm install && npx tsx spike/run-all.ts` (starts `wrangler dev`, workerd 1.20261103.1, local keys only).
Result: **14/14 pass**. Timings are scaled down for the run (ping 1.5 s, silence 5 s, grace 4 s); production values are 30 s / 75 s / 30 s.

## What was exercised

- Worker `src/index.ts` is a stateless router:
  - control: by the verified JWT's `relayHostId`;
  - phone: by `/v1/connect/<relayHostId>`;
  - data: by the `connId` prefix `<relayHostId>.<uuid>`.
- Durable Object `src/host-relay.ts`, one per host:
  - Hibernation API for every socket;
  - per-socket state in attachments;
  - session state (generation, resume-secret hash, orphan time) in storage;
  - alarm-driven ping, silence check, deadlines and orphan grace.
- Clients: the **shipped** desktop `RelayControlClient` and `CloudRelayTransport`, unmodified, plus the shipped phone `RelayPhoneHelloSchema`. The phone socket itself is a raw `ws` client sending the shipped `relay-auth` frame.

## R11 crypto/JWT in workerd: PASS
- tweetnacl `box` challenge, WebCrypto HMAC-SHA256 proof and the exact contract transcript builder: the shipped desktop proof verifier accepts them.
- ES256 JWT via a local JWKS: a valid token upgrades, a bad token gets 401 before upgrade, and a malformed host id gets 429.

## R5 shipped-client compatibility: PASS (control + data + phone parser)
- hello → challenge → proof → `host-hello-ack`, accepted by the shipped strict parser.
- Proof origin binding: the edge echoes the dialed origin. Both `127.0.0.1` and `localhost` prove, so one Worker serving many hostnames is fine.
- JSON `ping` from the alarm is parsed by the shipped client and answered with `pong`, and the control stays live.
- `conn-open` passes the strict parse. The `connId` prefix routes the shipped data socket to the right object.
- `relay-hello` (resume) passes the shipped phone schema.
- Rebind with `controlResumeSecret` within the orphan grace keeps the generation (3→3). The old control closes 4408 and the live splice keeps echoing.
- Not covered:
  - the real phone transport (React Native) and the E2EE handshake;
  - credential commands: invite, install, confirm and revoke all return `control-error unsupported` in the spike;
  - the director epoch check.

## R4 splice: PASS for correctness, RISK CONFIRMED for slow readers
- Text/binary frame type is preserved in both directions.
- 8 MiB text and 8 MiB binary frames pass host→phone.
- ~0.9 MiB phone→host passes. The shipped desktop caps inbound data frames at 1 MiB, so 8 MiB phone→host is not a client path.
- **Slow reader:**
  - Setup: phone TCP paused, host pushes 256 × 1 MiB.
  - Result: `send()` never throws or closes, and workerd RSS grew 239→755 MB (local). Workers WebSockets have no `bufferedAmount` (checked in workers-types), so the edge cannot see its outbound queue.
  - On Cloudflare an object is capped at 128 MB. One slow phone could get the object reset, which drops **every** socket for that host.
  - Mitigation options, to test on Cloudflare:
    1. Learn what CF does when the outbound buffer fills. Types say "socket is closed automatically"; need the actual limit.
    2. An edge-side byte budget per splice with no drain signal: close 4429 once more than N MB has been forwarded in a window where the reader sent nothing. Crude.
    3. An application-level ack window. This needs a client change, so it's out of scope.

## R2 local part: PASS (with one caveat)
- Generation floor and resume state live in object storage.
- After orphan grace the splices close 4408 and the next control gets generation+1, never a reused one.
- A control that never pongs is closed 4408 by the alarm silence check.
- **Caveat:** a forced reset (`ctx.abort()`) drops all sockets locally (1006), but storage keeps the floor (6→7). That is a hard reset, not hibernation. Whether hibernated sockets survive real eviction and deferred code updates can only be shown on Cloudflare.
- Bug found and fixed: during `webSocketClose` the closing socket is still listed by `getWebSockets()`, so orphan detection must clear its attachment first.

## Not testable locally (needs Cloudflare)
- R1 alarm and pong billing.
- R2 deferred-update behaviour with live splices.
- R3 runtime-restart drop rate.
- R4 CF outbound-buffer limit and the 128 MB object cap.
- R9 HK latency.
- Real hibernation (miniflare keeps objects in memory).

## Files
- `src/index.ts` router; `src/jwt.ts` ES256/JWKS; `src/host-relay.ts` object; `src/bytes.ts`; `src/env.ts`.
- `spike/run-all.ts` harness. `wrangler.jsonc`.
- The spike-only route `/__spike/abort/<hostId>` is gated by `SPIKE_ADMIN=1`.
- The phone credential check is a stub driven by `SPIKE_RESUME_TOKEN_HASHES`.
