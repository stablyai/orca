# Relay edge local spike: results (2026-11-04)

Run: `npm install && npx tsx spike/run-all.ts` (starts `wrangler dev`, workerd 1.20261103.1, local keys only).
Result: **17/17 pass** (default), **17/17** with `GUARD=1` (one of those checks only records the guard's false positive). Timings are scaled down for the run (ping 1.5 s, silence 5 s, grace 4 s); production values are 30 s / 75 s / 30 s.

## What was exercised

- Worker `src/index.ts` is a stateless router:
  - control: by the verified JWT's `relayHostId`;
  - phone: by `/v1/connect/<relayHostId>`;
  - data: by the `connId` prefix `<relayHostId>.<uuid>`.
- Durable Object `src/splice-relay.ts`, one per phone connection (`connId`): phone socket plus host data socket and the splice. It calls the host object over DO RPC (`authorizePhone`, `confirmSplice`, `spliceClosed`); the host calls back with `closeSplice` and `isAlive`.
- Durable Object `src/host-relay.ts`, one per host, now holds only control, session and connection bookkeeping:
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

## R4 splice: PASS. Mitigation = pooled splice objects per host. Drop the flood guard
- **Pool (latency fix):** on Cloudflare, creating a new object cost ~220 ms per phone connect (fresh-object upgrade p50 274 ms vs 50 ms for an existing object). Splices now go to a reused pool of 8 objects per host (`<relayHostId>.<slot>`).
  - connId is `<relayHostId>.<slot>.<uuid>`.
  - The Worker asks HostRelay (`allocateConnId`, one RPC) for the least-busy slot. Concurrent phones get distinct slots (local check: 4 concurrent → 4 slots).
  - A slot object can hold several splices, keyed by connId, if the hint collides.
  - State of closed or reset splices is deleted, so reused objects don't accumulate it.
- Correctness unchanged: text/binary type preserved; 8 MiB text and binary host→phone; ~0.9 MiB phone→host (the desktop caps inbound at 1 MiB).
- The slow-reader risk itself is unchanged: Workers WebSockets have no `bufferedAmount`, `send()` never fails, and local RSS grew 243→760 MB for 256 MiB pushed at a paused phone.
- **Isolation (the mitigation):**
  - While flooding one paused phone, the host control kept answering pings (6 during the flood) and a second phone on the same host echoed 16/16.
  - Resetting one splice object (`ctx.abort`) dropped only that phone (1006). Control and the other splice stayed up.
  - The host reclaimed the dead slot by probing `isAlive()` when its 8-connection budget filled: 6/6 new phones were accepted, and the 9th was refused with 4429.
  - So on Cloudflare the worst case is one slot object hitting the 128 MB cap and being reset. That drops the phone(s) in that slot (normally one); the host and its other slots don't notice.
- **RPC hop cost (local):** phone open → `relay-hello` p50 21.0 ms, p95 21.7 ms; `authorizePhone` RPC p50 1 ms, max 11 ms (n=33). Add one intra-colo RPC on Cloudflare (to measure).
- **Silent-bytes flood guard** (`SPLICE_SILENT_BYTES_MAX`, tested at 32 MiB per 10 s): **drop it.**
  - It cut the flood at 33 MiB and closed 4429, with RSS rising 242→298 MB.
  - But it also closed a legitimate phone that was reading normally while the host streamed 48 MiB, at 32 MiB (false positive). The edge can't tell a paused reader from a quiet one.
  - Isolation already bounds the damage to one phone. Left in the code disabled (0) for the Cloudflare test only.
- **Still needs Cloudflare:**
  - what the runtime actually does when a socket's outbound queue grows (limit, close code), and when an object hits 128 MB;
  - real cross-object RPC latency;
  - cost of the pool (requests and duration), and phone connect latency with the pool.

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
- `src/index.ts` router; `src/jwt.ts` ES256/JWKS; `src/host-relay.ts` host object; `src/splice-relay.ts` splice object; `src/bytes.ts`; `src/env.ts`.
- `spike/run-all.ts` harness. `wrangler.jsonc`.
- The spike-only routes `/__spike/abort/<hostId>` and `/__spike/abort-splice/<connId>` are gated by `SPIKE_ADMIN=1`. `GUARD=1 npx tsx spike/run-all.ts` runs with the flood guard on.
- The phone credential check is a stub driven by `SPIKE_RESUME_TOKEN_HASHES`.
