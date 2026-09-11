# Relay interruption investigation

Date: 2026-09-10. Source: fetched `origin/main` at `721a2692893ab29f8daee3149965bf5e9adf99a0`. Production unchanged. Tests ran in a source snapshot inside this worktree with `ORCA_BACKGROUND_LAUNCH=1`; no GUI, live devices, credentials, or production hosts were used.

## Decision

**Do not treat forced migration as universally harmless. Prefer extending the existing graceful migration so existing sessions finish on the old cell while new sessions use the target.** This replaces the proposed global idle check and admission-fencing handshake; it does not replace the preference freshness or meaningful-improvement fixes.

The simpler path is an event-driven extension of existing dual-origin ownership, not a new subsystem to determine whether users are busy. It requires a negotiated mode and lifecycle validation across desktop, director, and cell. The diagnostic timer removals below are not a shippable patch.

## What interruption does today

- Desktop opens target before making it active and retains basis-bound work on the source (`src/main/runtime/relay/relay-origin-pool.ts:215`, `:291`). The existing broker test covers that preservation during grace.
- Source cell starts an unconditional regional drain timer (`cloud/apps/relay/src/host-session-registry.ts:684`). At expiry, `:1231` closes every active splice with DRAINING (4503). Desktop independently schedules old-origin closure (`relay-origin-pool.ts:275`). Increasing only one timer or changing only desktop is insufficient.
- Mobile resolves a changed assignment using the existing credential, authenticates a replacement, and replays subscriptions. The custom supervisor/logical-client test demonstrates this route with a simulated DRAINING close and subsequent rejection on the old cell.
- Pending post-write RPCs become delivery-unknown (`mobile/src/transport/mobile-relay-rpc-session.test.ts:313`, `:325`). Logical replacement deliberately does not replay a terminal mutation (`stable-logical-rpc-client.test.ts:168`). This prevents blind duplication, but the user may not know whether an action executed. Recovery of viewing is not proof that all in-flight work was transparent.
- A running process is not itself the relay socket. These tests do not exercise a real PTY, so they do not establish full terminal/process survival. No claim of end-to-end user interruption duration is made.

## Actual experiments

| Experiment | Result | Limit |
| --- | --- | --- |
| Existing desktop broker/origin suites | 18 passed | Fake control/transport boundaries |
| Existing cell registry/drain/store suites | 95 passed | No real fleet or Postgres concurrency |
| Mobile RPC/failover/logical-client/reconnect suites including new drain recovery test | 64 passed, zero skipped | Fake network and native storage boundaries |
| Added desktop source-preservation oracle | Baseline FAIL, diagnostic PASS, restore FAIL | Proves timer cause and existing release-driven cleanup |
| Added cell source-preservation oracle | Baseline FAIL (4503), diagnostic PASS, restore FAIL | Proves cell timer independently forces closure |
| Added store long-migration oracle | PASS: 120 renew/cleanup rounds spanning a simulated hour; completed on source control release | SQLite and healthy controls; not a concurrency proof |

The desired preservation tests assert retaining the source after 30,001ms while target is active. Desktop also asserts that the existing final-connection callback closes only the old control/transport and leaves the target alive. Cell asserts a live source splice and control heartbeat survive the old deadline. Removing the two deadline scheduling sites in the isolated snapshot makes both pass; restoring the original source makes the same tests fail again.

The mobile recovery test takes **251ms of fake time**, comprising a 250ms retry floor plus one simulated socket event. This is NOT a latency measurement or an estimate of real user downtime. Real recovery adds socket establishment, director calls, E2EE, credential confirmation, and possibly backoff/retries. Therefore there is insufficient evidence to approve forced interruption as a reliably short user-visible event.

Commands, patches, environment adjustments, hashes, and explicit skip accounting: [experiment README](https://github.com/stablyai/orca/blob/0db9fdc486366f7451289f0c0599eed9ae1d94be/tests/tools/relay-rehome-interruption/README.md). Tests with `-t repro:` intentionally exclude unrelated cases; missing Postgres setup was not used to claim green PostgreSQL tests.

## Why retaining existing sessions is simpler than proving idle

The current director changes the assignment to the target and records a migration. The desktop already owns multiple cell origins, keeps old connections associated with their source, and removes a drained origin when its final connection ends (`relay-origin-pool.ts:291`). Token refresh already visits all origins (`:77`); the source cell maintains drain-only controls and heartbeats. The durable store requires zero source activity before completion (`assignment-store.ts:6281` vicinity), and already refreshes open rehome leases (`:6120`). The one-hour test exercises this existing state model.

An accepted connection that straddles the move can remain on the source and finish there. We need not make a globally atomic claim that nobody is using the desktop. This removes the reason for the proposed idle proof/fence protocol. Normal admission still needs to prevent attaching to an already retired source, and pending handshakes must count as retained work.

## Smallest production design to pursue

1. Add a negotiated **finish-existing-sessions** mode for optional regional optimization. Keep deadline-driven emergency/maintenance drains unchanged. The mode must travel through the durable attempt, cell host-drain call, desktop drain message, and replay/re-drain paths. Unsupported versions are excluded from this mode, not silently forced through the legacy deadline path.
2. Open the target through existing migration behavior. Keep live/pending source connections on their existing origin; new successful connections resolve to the target. Use existing connection-release ownership to retire the source after work ends. Verify pending control RPC completion, pending attach timeout, source-control close/orphan cleanup, and in-flight admission callbacks; extend cleanup events where necessary rather than introducing polling.
3. Keep auth/lease renewal and capacity accounting valid while both cells serve the host. Limit total concurrent open migrations, not just starts/minute, and retain one migration per host. Open migrations can last hours; a long session is not automatically a failed migration. Audit the existing 100-row refresh and 10-row work-page limits so long-lived rows cannot starve new work. Start with a small bound below those page limits or make traversal fair before expansion.
4. Preserve failure recovery: unreachable target, lost drain reply, duplicate drain with grace zero, desktop restart, source cell crash, expired credentials, late admissions, and abandonment cleanup must not turn this optional optimization back into an unconditional session-close deadline. Emergency operational drains can still interrupt work for their existing reasons.
5. Ship and test compatible desktop/director/cell support; then use fresh preference eligibility, >=25ms AND >=20% incumbent-relative advantage, bounded cohort and sampled benefit/reliability evidence. No fleet enable is authorized by these experiments.

This is a moderate cross-component extension, not a two-line production fix. It has fewer coordination requirements than a pre-move distributed idle gate, because active source work is allowed to exist. The focused tests establish the core reuse opportunity; integrated real-socket/mobile and real-Postgres tests are still required before shipping. The earlier independent review has not reviewed this replacement design.

## User experience and cost

An open session stays on its current path until it ends. The next connection uses the new cell. Saved pairing and local background processes do not by themselves delay retirement; a quiet but live relay connection does. If the mobile app actually closes its background connection, source cleanup can finish; merely backgrounding is not proof it has closed.

Tradeoff: users in a continuously open slow session do not receive the latency improvement mid-session. We accept that delay to avoid deliberately disrupting their work. Temporarily there are two controls and retained migration reservations; existing data stays on its source, it is not duplicated through both cells. Concurrency limits bound the additional capacity load. No dollar estimate was derived.

## Remaining boundary

This investigation found a simpler mechanism and reproduced its core behavior. It did not implement a compatible production feature, measure real-world outage distributions, or establish a zero-interruption guarantee under network/server failures. Original production source in the test snapshot was restored; diagnostic patches and tests are retained for review. User edits to package.json and tests/tools/relay-bench were preserved.


## Terminology clarification

“Ongoing session” in the proposal means a still-open physical relay data connection between a client (such as mobile) and the desktop, forwarded as a splice by a relay cell. It is not a terminal process, a running agent, saved pairing, or evidence of recent typing. The connection carries RPCs and subscriptions and may be quiet while still open. Source retirement additionally waits for tracked pending connection/control work; it is not defined solely by a visible terminal tab.

No measured typical session length or fixed maximum for the proposed finish-existing-sessions mode has been established. An individual connection ends when closed, failed, or replaced. Existing forced drain grace is a separate timer the proposal would avoid for optional optimization. Current mobile source schedules suspension of a healthy retained relay after 30 seconds in the background; if the runtime timer does not execute, the foreground handler checks the elapsed deadline. Therefore 30 seconds is the scheduled grace, not a guaranteed time the server observes disconnection. If foreground resumes before expiry, the timer is cleared. Never promise that closing one terminal ends the relay connection or that updating moves an existing open connection mid-session.


## Follow-up review limitation

The GPT-6-astra / low review found an independent 6h ±30m control lease, renewed only for the active origin, and a 24-hour durable rehome refresh ceiling. Auth refresh across origins does not extend the source control lease. Therefore the two timer-removal experiments and one-hour SQLite test do not prove arbitrarily long live source retention. The revised plan now requires explicit same-generation source renewal, retained-source rollback, and mode-aware durable lifetime/rollback compatibility. See [archived relay region correction review v2](https://github.com/stablyai/orca/blob/0db9fdc486366f7451289f0c0599eed9ae1d94be/docs/relay-region-correction/RELAY-REGION-CORRECTION-REVIEW-V2.md); no further test or implementation validation has been claimed.
