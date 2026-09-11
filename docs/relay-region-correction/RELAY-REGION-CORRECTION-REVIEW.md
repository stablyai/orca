# Independent review: relay automatic region correction

Verdict: **REVISE**. Reuse of the existing bidirectional director worker is correct. The freshness fixes are justified, but the proposed idle gate is not implementable safely from current activity leases, and the evidence contract and incumbent comparison remain underspecified. Do not enable relocation on the strength of this plan as written.

Reviewed by GPT-6-astra, medium reasoning, on 2026-09-10. Ran `git fetch origin main`; reviewed named `origin/main` at **721a2692893ab29f8daee3149965bf5e9adf99a0** using bounded `git show`/`git grep` reads from this worktree. Source references below refer to that immutable revision, not the old checked-out files. Read the plan, rollout progress, AGENTS.md, relay-ops skill and operational references, and the remote-wire/SSH boundary documents. No production queries or mutations, workflow dispatches, app launches, tests, commits, pushes, or external messages were performed. Dated production observations were not independently refreshed.

## Severity-ranked findings

### P1 — Current activity leases cannot certify that a host has no live data sessions

Plan lines 34 and 42 propose an idle gate using existing director machinery, and line 45 leaves a cell image change unestablished. A director-only `NOT EXISTS` over unexpired splice leases would allow relocation of actively used sessions.

Evidence:

- `cloud/apps/relay/src/host-session-registry.ts:404` acquires a splice activity once when host data attaches; `:430` wires the sockets and `:461` retains the live splice. The close callback releases its lease at `:438`.
- `cloud/apps/relay/src/assignment-store.ts:3265` gives that activity the default lease lifetime; `cloud/packages/relay-contract/src/assignment-invariants.ts:5` sets it to 90 seconds.
- Heartbeat calls `renewControlActivity` at `host-session-registry.ts:1111`; its Postgres update at `assignment-store.ts:3381` explicitly updates only the named control lease. The transactional implementation at `:3483` likewise updates only that activity. It does not renew splices.
- `assignment-store.ts:6804` selects expired activity leases and `:6853` removes them. Neither path consults the cell's live socket maps.
- `host-session-registry.ts:681` starts the regional drain and `:684` installs unconditional session teardown at the grace deadline. Desktop `src/main/runtime/relay/relay-origin-pool.ts:280` also installs unconditional old-origin closure.

Concrete failure: a phone has been streaming for several minutes. Its splice lease has expired and been swept while control remains healthy. A locked SQL idle check sees no splice and allows rehome; the grace deadline closes the phone's live transport. This is not repaired by taking stronger SQL locks.

Smallest correction: treat DB activity as a conservative prefilter, not an authoritative idle verdict. Add an opt-in, capability-negotiated guarded handoff in the existing cell drain path, using the owning cell's active and pending connection maps and in-flight pairing operations. The idle check and stopping new admission must form one cell-local state transition; busy/unknown must defer, with the existing provisional migration rolled back safely if already claimed. An alternative is to establish and prove a complete session lease/fencing contract first, but that is larger than a query change. Remove any assumption that a cell rollout is unnecessary. Unsupported cells remain excluded from the new safe mode.

### P1 — A locked idle claim does not fence clients admitted immediately afterward

This is a separate race even if splice lease freshness is repaired.

Evidence:

- `host-session-registry.ts:251` reads the assignment, then separately reserves credentials at `:263`, checks the local session at `:275`, and acquires an invite/confirmation activity at `:307`.
- `assignment-store.ts:3242` deliberately allows activity on the old source while the exact forward migration remains active. At `:3269` it distinguishes renewal, but the subsequent insert at `:3288` is also allowed by that same authorization.
- The regional claim changes assignment and records the migration at `assignment-store.ts:5677` and `:5722`; dispatch reaches cell `drainHost` later.
- `host-session-registry.ts:385` allows pending host-data attachment in `drain-only` state.

Concrete failure: client assignment lookup finishes before claim, then claim sees idle and commits. Before drain reaches the cell, the client acquires its confirmation/splice activity against the active migration and becomes a live source session. It will later be closed at the migration deadline despite the locked idle check having passed.

Smallest correction: the same guarded handoff must serialize admission with the idle verdict. If implementing a director admission fence, distinguish new source activity from renewal of already admitted activity and scope the rule to automatic idle-only rehome; do not break ordinary graceful evacuation. Prove the race across separate Postgres connections and cell execution, including credential reservation before claim, admission after claim, host attach after drain, and a busy rejection after provisional assignment change. Merely listing a race test without a specified fence is not a complete design.

### P1 — Relative age plus policy version does not establish report ordering or non-resurrection

Plan line 40 states invariants but does not supply the state needed to enforce them. A random decision ID alone would deduplicate without ordering; a policy version identifies the algorithm, not which measurement is latest.

Evidence:

- `assignment-store.ts:7205` currently receives a region and server observation time. Its conflict update at `:7217` chooses by receipt time.
- `src/main/runtime/relay/relay-region-preference.ts:44` persists only cache version, director, region, latency, and expiry. It has no decision generation or report acknowledgment.
- `src/main/runtime/relay/relay-http-client.ts:178` sends the report with an HTTP deadline. Client timeout does not prove the server never commits a delayed request.

Concrete failure: a conclusive report A stalls; a newer inconclusive report B arrives and revokes eligibility; A arrives later and restores the old region. Increasing `ageMs` on normal cache hits does not prevent this. Computing `serverNow + TTL - ageAtSend` also includes transit delay, and duplicate delivery with different delays can extend expiry unless the server retains the earlier deadline. A client wall-clock rollback can understate cache age.

Smallest correction: choose and document one ordered report protocol before implementation. Separate ordering, freshness, and algorithm support. Required stored concepts are authoritative report generation, conclusive/inconclusive outcome, supported policy, fixed server expiry, and the incumbent assignment basis; preserve an inconclusive tombstone so delayed conclusive reports cannot resurrect eligibility. Repeated reports of one generation must never increase its accepted expiry. Define how a writer restart or cache reset obtains a new generation rather than reusing sequence values.

A concrete conservative option is a server-issued generation/window obtained through the assignment exchange before probing. Its expiry is fixed when issued; the client probes only after receiving it, and only the current generation can publish an outcome. Cache the window and decision; retries reuse them. Issuing a successor invalidates the predecessor for migration, and clock uncertainty/restart may discard the cache and request a fresh window. This trades an extra exchange for avoiding client-clock and first-delivery ambiguity. Keep it opt-in because old response decoders are strict. A smaller client-sequence design is acceptable only with a specified writer fence and explicit bounded clock/transit assumptions; it cannot honestly promise exact freshness without those qualifications.

Legacy requests may continue placement/reconnect, but must not overwrite fields of a verified decision while retaining its eligibility. Keep the legacy hint separate or conservatively revoke verified eligibility on that write. Diagnostic overrides (`relay-region-preference.ts:78`, `:247`) are not measured decisions and must not automatically qualify.

### P2 — Existing hysteresis protects the previous preference, not the current assignment

Plan line 41 proposes reusing the resolver unchanged while line 40 invalidates its cache. That loses the only incumbent passed to selection.

Evidence:

- `relay-region-preference.ts:187` passes `previous?.region` to selection.
- `:310` selects the fastest region immediately when no previous region exists or the fastest equals that previous region.
- Only `:317` applies the 25 ms and 20% margin. That margin compares the previous hint to the new winner, not the assigned region.
- The director moves on region mismatch at `assignment-store.ts:5328`; it has no improvement magnitude.
- `cloud/packages/relay-contract/src/director-messages.ts:24` returns cell URL and assignment epoch, but no explicit assigned region.

Concrete failure: a cache upgrade deletes a legacy hint; measurements are Asia 101 ms and US 100 ms while the assignment is Asia. US becomes a fresh supported winner and can trigger migration for a 1 ms difference. The same problem persists when the old hint already names US but the sticky assignment is Asia. Cooldown limits frequency but does not make that move worthwhile.

Smallest correction: distinguish initial placement preference from migration eligibility. Reuse the sampling and 25 ms/20% thresholds, but compare against a fresh measurement of the actual assigned region. Obtain assigned region explicitly through the opt-in assignment response, bind the decision to assignment epoch/region, and reject a stale basis under the claim lock. Do not infer region from hostname spelling. If incumbent region cannot be established or both sides cannot be measured, keep placement functional and withhold relocation eligibility. Include cache-upgrade, hint/assignment mismatch, nearly tied regions, and post-migration refresh tests.

### P2 — Refresh integration needs an explicit owner and must not couple probe failures to authentication failure

Plan line 41 is directionally right, but “existing lifecycle scheduling” does not specify the integration that makes stable connections converge.

Evidence:

- `relay-session-broker.ts:241` schedules auth renewal; `:268` refreshes origin authorization without a new assignment request. Its failure path retries and eventually closes the broker at `:282`.
- `relay-origin-pool.ts:237` schedules control rebind; `:261` reuses the current assignment without probing/reporting.
- Target resolution currently runs through drain/recovery at `:156`; even a same-origin response causes rebind at `:182`. Concurrent rotation is managed by `rotationPromise` at `:149` and `:254`.

Concrete failure: adding probing/reporting inside the auth renewal `try` makes an optional health/catalog failure consume the auth failure path. Reusing `handleDrain` as a daily timer also reports a healthy connection as draining and forces same-origin rebinds. A standalone background assignment call could instead miss a changed assignment or race a real drain.

Smallest correction: let the broker own one decision deadline, canceled by `closeNow`, and check it from existing auth/control lifecycle and resume entry points. If those entry points cannot bound the desired delay, schedule that deadline explicitly while registered. Run probes outside the auth-success critical path, single-flight with drain-triggered resolution, and use one origin-pool assignment application method: same cell/epoch updates metadata without reopening control; a newer assignment follows existing rotation; stale responses are discarded. Document 24-hour successful refresh, one-hour inconclusive retry, network-failure backoff, jitter, sleep/resume behavior, and report retry distinct from re-probing. Eligibility expiry and next retry time are different concepts.

### P2 — Outcome counters prove movement, not a better user connection

Plan line 43 measures completion and exclusions but cannot establish the intended benefit.

Evidence:

- `relay-region-probe.ts:72` measures desktop HTTP `/health`, and `:123` uses the fastest origin per round. `:149` rejects spread but does not measure the mobile-to-cell leg or application response time.
- `relay-region-preference.ts:189` constructs comparative refresh diagnostics; its persistence is console logging at `:227`. The progress file correctly says comparative production evidence is unavailable.
- `host-session-registry.ts:430` shows the actual data path comprises client and host sockets; making only the host leg faster need not improve a geographically distant mobile client's total path.

Concrete failure: target registration succeeds and regional mismatch drops, yet the phone's RPC latency gets worse, or the selected target cell is slower than the fastest sampled catalog cell. All proposed rollout counters remain green.

Smallest correction: retain compact sampled comparative evidence, not every probe: policy, fresh assigned-region and target-region measurement, margin, assignment direction, and decision/migration outcome. Add matched pre/post assigned-cell RTT and mobile application RPC/connection-success evidence with a contemporaneous unchanged cohort. Report sample counts, missingness, reconnect/error rates, and latency distributions; do not claim causality from a few successful registrations. Fix acceptance criteria before enabling a cohort: meaningful measured host-leg benefit, no material application-latency or connection-reliability regression, and no forced closure of pre-existing sessions in idle-only mode. Logs and aggregates must avoid raw host identifiers and credentials.

## Session semantics and coverage

- A saved pairing is not an active session. Invite/confirmation activities are acquired during connection admission (`host-session-registry.ts:301`); persisted pairing alone must not count as busy.
- A live relay splice counts as busy even with no recent bytes. The relay cannot infer whether quiet encrypted RPC is harmless to disconnect. Pending attaches, pairing installs, and confirmations also need protection.
- Current mobile intentionally retains a healthy relay for a 30-second background grace (`mobile/src/transport/mobile-relay-background-grace.ts:5`, `:106`). It suspends after that grace (`:130`), and enforces an overdue deadline on foreground (`:124`) if background timers were suspended. Backgrounding is therefore not immediate idle proof, nor a guaranteed 30-second server-observed disconnect. Older mobile behavior may differ. Direct mobile connections do not create this relay splice and need not block relay relocation.
- The SSH relay daemon is a different transport: `src/main/ssh/ssh-relay-deploy.ts:1845` bridges an SSH exec channel to the daemon's Unix socket. Merely having a direct SSH target/terminal open does not imply a cloud-relay splice. A mobile session accessing that work through the desktop's cloud relay does count as busy; a paired remote runtime's cloud relay has its own owning host identity. Do not classify by workspace type, git presence, or terminal process count. Transport loss leaves remote execution unverifiable, not exited.
- The existing graceful migration is smaller operationally and preserves source connections only until grace expires. It cannot meet the plan's active-session-preservation promise. Using it without a new idle handshake is defensible only if that promise is explicitly weakened to bounded interruption; that is a product decision, not an equivalent implementation.

## Cloud-only alternative and independent fixes

There is no demonstrated cloud-only route to the stated full outcome. The director can conservatively age or ignore stored hints and operate the existing worker, but it cannot obtain current comparisons from a stable desktop that never calls the resolver. Existing receipt timestamps cannot distinguish a recent measurement from a cached report. A tightly bounded pilot of independently validated hosts using existing migration tooling could demonstrate usefulness sooner, under separate authorization and with interruption limits understood; it would not solve fleet freshness or active-session safety. Global rate limiting is not selected-host membership.

The receipt-age, explicit-inconclusive, and lazy-refresh findings are source-proven gaps relative to the proposed automatic correction policy. They are not proof that today's disabled rollout caused any sampled production host's RTT. Fixing their contracts independently while rehome stays disabled is reasonable. Avoid expanding scope into IP geolocation, a second placement engine, or central storage of every raw probe.

Candidate eligibility must be filtered before `LIMIT 10` (`assignment-store.ts:5372`), then rechecked under lock. Otherwise the same oldest busy/out-of-cohort rows can starve eligible rows forever. Retain existing rate/cooldown/failure controls; stable cohort filtering can be a narrow extension of that control record rather than a new rollout subsystem. Preview must not create attempts, acquire dispatch claims, or charge failures, and must distinguish full aggregate counts from the ten-row work queue.

## Revised minimal plan

1. Keep rehome disabled. Specify the ordered, expiring decision contract, incumbent assignment basis, opt-in response negotiation, and legacy/rollback behavior. Preserve inconclusive tombstones; never extend cached decision expiry. Test delayed old reports, duplicate retry, restart, clock jumps, policy upgrade, omitted fields, overrides, and new/old director pairs. Both request and response schemas are strict (`director-messages.ts:22`, `:31`); existing 400 fallback strips only existing fields (`relay-http-client.ts:200`), so new fields need deliberate fallback handling.
2. Reuse existing desktop probes, adding incumbent-relative migration eligibility and one lifecycle-owned refresh/report flow. Keep authentication and healthy control alive if optional comparison/reporting fails. Serialize assignment application with drain/recovery. No continuous probe collection or 30-minute fleet sweep.
3. Extend the existing cell/director migration handshake with an opt-in idle-only transition that atomically checks active/pending work and fences admission. Treat missing capability or unknown state as ineligible. Prove rejected busy handoffs roll back safely without premature client relocation. This is the principal safety prerequisite and may require a cell rollout; do not pretend SQL lease filtering supplies it.
4. Add pre-limit candidate filters and locked rechecks for fresh supported decisions, matching incumbent basis, cohort, capability, and conservative activity exclusions. Keep existing bidirectional moves, capacity, cooldown, durable attempts, and disable/failure-budget mechanisms. Validate both directions and concurrent admissions in real Postgres on port 55440 when implementation exists; skipped suites are not evidence.
5. Add aggregate preview plus compact sampled benefit/reliability evidence and explicit rollout acceptance criteria. Deploy compatible director support and required cell capability before enabling updated desktop decisions. Expand only from an authorized bounded cohort whose session-safety and latency evidence pass. Old clients, unsupported cells, continuously connected foreground clients, and inconclusive measurements are explicit convergence exclusions.

**Final decision: REVISE**, primarily for authoritative session safety and ordered freshness. The overall reuse-first approach should proceed after those corrections; neither a second placement engine nor an immediate fleet enable is warranted.
