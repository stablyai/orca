# SOL-014: `telemetry.track` — a real product decision blocks implementation; here is the shape it would take once made

**Resolves:** [BUG-014](../BUG-014-telemetry-track-no-op.md)
**Service:** None yet — **blocked on a product decision** (does backend-go send telemetry at all, under what identity, with what consent model). If/when unblocked: a per-user consent field on `tenant-service` (mirrors SOL-005's reuse of that service for small per-user preference state) + a stateless forwarding adapter in `api-gateway` (no new microservice — see §Where this would live)
**Affected files (proposed, contingent on the product decision — none of this should be built before that decision is made):**
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_telemetry.go` (replace the current no-op body)
- `backend-go/services/api-gateway/internal/adapter/telemetry/allowlist.go` (new — Go equivalent of `shared/telemetry-events.ts`'s event schema table)
- `backend-go/services/api-gateway/internal/adapter/telemetry/posthog_client.go` (new — vendor forwarding adapter)
- `backend-go/proto/orca/tenant/v1/tenant.proto` (additive: consent state on `UserProfile`, or a new `GetTelemetryConsent`/`SetTelemetryConsent` RPC pair)
- `backend-go/services/tenant-service/internal/domain/user_profile.go` (add `TelemetryConsent` field)
**Status:** 🚧 Proposed — no code written, and this proposal is explicitly **not ready to implement** until the product decision below is made

---

## Why this is a product decision, not an engineering gap — restated concretely

`channels_telemetry.go`'s own doc comment (`:1-15`) already calls this
"out of scope," but frames it as a scoping choice about *how much work
porting PostHog integration is*. Reading the old backend's actual
implementation shows the real blocker is upstream of any engineering
estimate — the entire consent/identity model the old client relies on
**does not have an obvious backend-go equivalent**:

- **Identity**: `commonProps.install_id`
  (`backend/src/main/telemetry/client.ts:101-116`) is a per-**desktop-
  installation** anonymous UUID, generated once and persisted in that
  install's local `orca-data.json`. `posthog.capture` uses it as
  `distinctId` (`client.ts:302-310`) specifically so PostHog never
  correlates events to a real user identity — "we explicitly do not want
  [a PostHog person] for anonymous-only events" (`client.ts:23-27`).
  backend-go has no "installation" concept at all — every session is a
  `(tenant_id, user_id)` pair against a real, identifiable account. Reusing
  `user_id` as `distinctId` would be a **materially different privacy
  posture** than the desktop product ships today (named-user analytics
  instead of anonymous-install analytics) — not a porting detail, a
  decision the product/privacy owner has to make explicitly, the same way
  `missing-v1/SOL-007`'s credentials proposal flagged making credentials
  tenant-wide instead of per-user as "a real behavior change... flagged for
  explicit sign-off rather than silently ported."
- **Consent gating**: `resolveConsent` (`consent.ts`) reads a single
  **local machine's** `GlobalSettings.telemetry.optedIn`, with CI/env-var/
  `DO_NOT_TRACK` escape hatches meaningful only on a machine the user
  controls directly. In a multi-user server deployment, "did this device
  opt out" doesn't cleanly map to "did this authenticated user, on a
  server this tenant's admin operates, opt out" — is consent per-user? Per-
  tenant (an admin toggle covering everyone)? Does a tenant admin's opt-out
  override an individual user's own preference, or the reverse? None of
  this is decided anywhere in `specs/backend-go/tdd/`.
- **Build-identity gating**: `IS_OFFICIAL_BUILD`
  (`client.ts:65-76`) requires CI-injected `ORCA_BUILD_IDENTITY`/
  `ORCA_POSTHOG_WRITE_KEY` constants baked into a specific desktop build —
  a concept with no backend-go analog (there's one server binary, not a
  matrix of contributor/rc/stable builds each with different telemetry
  eligibility).
- **Cohort enrichment**: `getCohortAtEmit()`/`getOnboardingCohortAtEmit()`
  (`telemetry.ts:27-28,72-77`) read live local state (repo count, onboarding
  progress) to attach cohort tags — that data exists in backend-go
  (`project-service`, an eventual onboarding-tracking home), but reading it
  synchronously on every `telemetry.track` call would add cross-service
  calls to a fire-and-forget analytics path that today costs nothing
  (`telemetry.ts`'s own doc comment: every frontend call site already
  treats a dropped/failed call as non-fatal).

None of these are "we haven't gotten to it yet" gaps — they're each a
real choice with a wrong-by-default answer (e.g., silently switching from
anonymous-install to named-user analytics identity would be a privacy
regression, not a neutral port). This proposal does **not** make any of
them; it sketches the shape assuming reasonable defaults get chosen, per
the pattern `missing-v1/SOL-006`'s browser-driving gap already set for this
solutions directory: flag the blocker honestly, still show the design that
would follow once it's resolved.

## What implementing this WOULD look like, once the decision is made

Assumed defaults for this sketch only (each needs real product sign-off,
not just engineering judgment):
- Telemetry is **per-user opt-in/opt-out**, stored as a `tenant-service`
  preference (same "small per-user state, no natural service" shape
  `SOL-005` already argues belongs there — see that proposal's
  owning-service verdict for the same reasoning applied to a different
  6-field-sized preference blob).
- `distinctId` is a **per-`(tenant_id, user_id)` pseudonymous hash**, not
  the raw `user_id` and not a PostHog "person" — closer to the old
  anonymous-install model than to named-user analytics, pending explicit
  confirmation this is the right call for a multi-tenant server product.
- Cohort enrichment is dropped from the v1 cut (accept coarser analytics)
  rather than adding synchronous cross-service calls to a fire-and-forget
  path — a scope reduction from the old backend, flagged as a trade-off,
  not hidden.

### 1. Consent state — a `tenant-service` field, not a new table

Reuses the exact same "tiny per-user preference, no natural owning
service, closest fit is `tenant-service`'s existing per-user state" logic
`SOL-005` already establishes for `starNag.*`. Rather than a whole new
table, this fits directly on the existing `UserProfile` aggregate
(`tenant-service.md` §4,§5) as one more settings field:

```go
// tenant-service/internal/domain/user_profile.go — additive field
type TelemetryConsent struct {
    OptedIn   *bool  // nil = "existed before telemetry release, pending banner" (existedBeforeTelemetryRelease + optedIn===null in TS)
    Via       string // "first_launch_banner" | "settings" — last mutation's source, for the Privacy pane
}
```

```protobuf
// tenant.proto — additive
message UserProfile {
  // ... existing fields ...
  TelemetryConsent telemetry_consent = N;
}
rpc SetTelemetryConsent(SetTelemetryConsentRequest) returns (google.protobuf.Empty);
rpc GetTelemetryConsent(GetTelemetryConsentRequest) returns (TelemetryConsent);
```

`telemetry.setOptIn`/`telemetry.getConsentState`/`telemetry.acknowledgeBanner`
(the other 3 methods `TELEMETRY_METHODS` already registers alongside
`track`, `telemetry.ts:82-112`) would wire directly to these two RPCs —
that part IS a mechanical port once the RPCs exist, unlike `track` itself.
**Not designed further here** — `BUG-014` is scoped to `telemetry.track`
specifically; these three are a separate, smaller wiring task if they
aren't already covered elsewhere in this bug batch.

### 2. Event allowlist — a Go equivalent of `telemetry-events.ts`, decode-and-validate before anything forwards

```go
// api-gateway/internal/adapter/telemetry/allowlist.go
type EventSchema struct {
    Name       string
    MaxProps   int            // strict key-count cap, mirrors .strict() intent
    PropTypes  map[string]reflect.Kind // coarse per-field type check; a full port would mirror each Zod schema exactly
}

var allowedEvents = map[string]EventSchema{
    "app_opened": {Name: "app_opened", MaxProps: 4, PropTypes: map[string]reflect.Kind{"nth_repo_added": reflect.Int}},
    // ... one entry per EventName in telemetry-events.ts's eventSchemas record —
    // NOT reproduced in full here; porting the ~30+ event schemas verbatim
    // is mechanical once the identity/consent decisions above are settled,
    // and belongs in the real implementation, not this design doc.
}

func Validate(name string, props map[string]any) (map[string]any, bool) {
    schema, ok := allowedEvents[name]
    if !ok {
        return nil, false // unknown event name — fail closed, same as validator.ts's schema-level safeParse failing
    }
    if len(props) > schema.MaxProps {
        return nil, false
    }
    // ... per-field type/enum checks against schema.PropTypes ...
    return props, true
}
```

### 3. The channel handler — decode, consent-gate, validate, forward

Preserves `client.ts`'s own documented ordering (`client.ts:8-27`) —
shutdown/consent before validation, validation before the vendor call:

```go
// channels_telemetry.go — replaces the current no-op body
func registerTelemetryChannels(r *Registry, tenantClient tenantv1.TenantServiceClient, sink telemetry.Sink) {
    r.Register("telemetry.track", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
        var in struct {
            Name  string         `json:"name"`
            Props map[string]any `json:"props"`
        }
        if len(args) == 0 {
            return nil, nil // matches the frontend's fire-and-forget contract — malformed calls still ack quietly
        }
        if err := json.Unmarshal(args[0], &in); err != nil || in.Name == "" {
            return nil, nil
        }

        // Consent resolve — reads live tenant-service state every call,
        // same "never a cached boolean" discipline client.ts:281-284 documents.
        consentCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
        consent, err := tenantClient.GetTelemetryConsent(attachTenantIdentity(consentCtx, id), &tenantv1.GetTelemetryConsentRequest{})
        if err != nil || !consent.GetOptedIn() {
            return nil, nil // fail closed: an error resolving consent must never be treated as "opted in"
        }

        props, ok := telemetry.Validate(in.Name, in.Props)
        if !ok {
            return nil, nil // unknown/malformed event — silently dropped, same as validator.ts's safeParse failure
        }

        sink.Capture(ctx, telemetry.Event{
            DistinctID: pseudonymousDistinctID(id.TenantID, id.UserID), // see identity caveat above — NOT id.UserID directly
            Name:       in.Name,
            Props:      props,
        })
        return nil, nil
    })
}
```

`telemetry.Sink` is a small interface (`Capture(ctx, Event) `) so the
vendor (PostHog, or whatever the product decision lands on) is swappable
and unit-testable without a real network call — same shape
`_setPostHogClientForTests` gives the old TS suite (`client.ts:470-472`),
minus the module-level-singleton pattern (backend-go handlers get their
dependencies injected, not read from a package global).

### Where this would live — no new microservice, same reasoning as SOL-005

Checked `02-microservices-decomposition.md`'s design principle #4 again:
a stateless "decode, consent-check, forward to an external vendor" path
owns **zero** Postgres data of its own (`credential-broker-service`'s own
"metadata only, never persists the secret" pattern is the closest
precedent for "this service mediates, it doesn't own"). `usage-service`
looks adjacent by name but is the wrong fit on inspection — its scope is
"AI-CLI usage/cost tracking" (`00-service-catalog.md` row 12), a
billing/quota concern with its own schema, not generic product-analytics
events. Proposed home: the forwarding adapter lives directly in
`api-gateway` (which already "owns no business data itself" per its own
service-catalog row) alongside the other stateless `wscompat` channels,
calling `tenant-service` for consent exactly the way `channels_dev_server_
access_control.go` already calls cross-service for its own authorization
checks. If cohort enrichment is added back in a later iteration (reversing
the v1 scope-cut above), that's the point at which a dedicated ingestion
path might earn its own service — not decided here, since it depends on
which service ends up owning onboarding/repo-count state, itself unsettled
today.

## Test plan (once unblocked)

- `allowlist_test.go` — known event name + valid props round-trips;
  unknown name rejected; over-cap prop count rejected; wrong prop type
  rejected.
- `channels_telemetry_test.go` — fake `TenantServiceClient` + fake `Sink`:
  opted-out user's event never reaches `Sink.Capture`; consent-RPC error
  fails closed (no capture); opted-in + valid event reaches `Sink.Capture`
  with the expected `DistinctID`/`Name`/`Props`; malformed/empty args still
  ack `nil, nil` rather than erroring (preserves the frontend's fire-and-
  forget contract, `telemetry.ts`'s doc comment).
- Explicitly no vendor-integration test (real PostHog network call) in this
  suite — `Sink` is a fake in every test, matching `client.test.ts`'s own
  reliance on `_setPostHogClientForTests` rather than a live PostHog
  sandbox.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_telemetry.go:1-30` — current no-op, its own doc comment already citing the old backend as the reason it's out of scope
- `backend/src/main/telemetry/client.ts:1-497` — full old implementation: identity (`:101-116`), build-gating (`:49-76`), ordering discipline (`:8-27`), `track()` (`:257-311`), consent-vs-SDK-opt-out interplay (`:191-217,313-390`)
- `backend/src/main/runtime/rpc/methods/telemetry.ts:1-113` — server-mode RPC wrapper: cohort enrichment (`:71-78`), `MAIN_OWNED_TELEMETRY_EVENTS` exclusion (`:34-38`), the 3 sibling methods (`setOptIn`/`getConsentState`/`acknowledgeBanner`) not designed further here
- `backend/src/main/telemetry/consent.ts:1-60+` — `resolveConsent`'s env-var/CI/opt-out precedence, the local-machine consent model with no obvious multi-tenant-server equivalent
- `backend/src/shared/telemetry-events.ts:1-60+` — Zod-first event schema catalog, the source this design's Go `allowlist.go` would need to port in full
- `frontend/src/renderer/src/lib/telemetry.ts` — fire-and-forget contract every call site already relies on (referenced by `BUG-014` itself)
- `specs/backend-go/tdd/services/tenant-service.md` §2,§4,§5 — `UserProfile`/`Settings` shape this design's consent field extends
- `specs/backend-go/tdd/services/usage-service.md`, `00-service-catalog.md` row 12 — why `usage-service` is NOT the right home despite the name-adjacency
- `specs/backend-go/tdd/architecture/02-microservices-decomposition.md` — design principle #4, `credential-broker-service`'s "mediates, doesn't own" precedent this proposal's "no new service" verdict follows
- `specs/backend-go/bugs/missing-v1/solutions/SOL-007-credentials-channels.md` (referenced via its own README summary) — precedent for flagging an identity/scope change as a product decision rather than silently porting it
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md` — house style this proposal follows: honest blocker, design sketched anyway, nothing implemented
- `specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md` — the sibling proposal in this same batch establishing the "tiny per-user preference state folds into `tenant-service`" pattern this design reuses for telemetry consent
