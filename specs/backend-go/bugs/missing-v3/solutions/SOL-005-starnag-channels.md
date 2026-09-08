# SOL-005: `starNag.*` — a tiny per-user preference table on `tenant-service`, pushed over the gateway's existing notification stream

**Resolves:** [BUG-005](../BUG-005-starnag-channels-not-implemented.md)
**Service:** `tenant-service` (new `star_nag_state` table + 10 usecases — no new microservice) + `api-gateway` (new `wscompat` channels, reusing the existing `RegisterStream`/`PushEvent` push mechanism and `notification-service`'s existing `StreamNotifications` delivery path)
**Affected files (proposed):**
- `backend-go/proto/orca/tenant/v1/tenant.proto` (10 new unary RPCs, additive)
- `backend-go/services/tenant-service/internal/domain/star_nag_state.go` (new)
- `backend-go/services/tenant-service/internal/usecase/star_nag_actions.go` (new — 10 usecases, one file per the desktop's own single-file `star-nag.ts` precedent)
- `backend-go/services/tenant-service/internal/usecase/ports.go` (add `StarNagStateRepository`, `ScmStarCheckPort`)
- `backend-go/services/tenant-service/internal/adapter/postgres/star_nag_state_repository.go` (new)
- `backend-go/services/tenant-service/migrations/000X_star_nag_state.up.sql` (new)
- `backend-go/services/notification-service/internal/adapter/eventbus/star_nag_visibility_consumer.go` (new — one more subscribed subject, §3 of `notification-service.md`)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag.go` (new)
- `backend-go/services/api-gateway/cmd/server/main.go` (wire `registerStarNagChannels`)
**Status:** 🚧 Proposed — no code written

---

## Porting source — the exact state this design must reproduce

The old TS backend already ported all 12 `starNag.*` methods for server mode
(`backend/src/main/runtime/rpc/methods/star-nag.ts:1-142`), delegating every
call to the single `StarNagService` singleton
(`backend/src/main/star-nag/service.ts:46-408`). That class's persisted state
— read via `store.getUI()`/`store.updateUI()` — is exactly six fields
(`backend/src/shared/types.ts:3497-3515`):

| TS field | Type | Meaning |
|---|---|---|
| `starNagBaselineAgents` | `number \| null` | Agent-spawn count at the last threshold reset (§"Explicitly out of scope" below) |
| `starNagAppVersion` | `string \| null` | App version the baseline was computed for |
| `starNagNextThreshold` | `number` | Agents-until-next-prompt, doubles on each dismiss/later |
| `starNagCompleted` | `boolean` | Permanent suppression — user starred or opted out for good |
| `starNagDeferredUntil` | `number \| null` | Cooldown expiry (epoch ms) |
| `starNagAgentValueMomentAppVersion` | `string \| null` | One agent-value-moment attempt per app version |

Plus one **in-memory, per-process** field TS never persists —
`promptSession` (`service.ts:66`, `StarNagPromptSession`) — holding the
currently-shown prompt's `source`/`mode`/`openedRepoTracked`/
`starAttemptPromise`, read by `dismiss`/`defer`/`openWeb`/`starOrcaFromNag`
to know what to act on and what telemetry outcome to log
(`service.ts:248-264,307-354`). Backend-go has no single long-lived process
per user, so this design persists a trimmed version of it (§Domain model)
rather than reintroducing an in-memory singleton.

## Owning-service verdict: fold into `tenant-service`, don't create a service

`grep`-confirmed by BUG-005: zero `StarNag`/`ValueMoment` concept exists
anywhere in `backend-go/` today. Checked both docs the task brief points at:

- **`notification-service.md`** owns "WS fan-out" as a *delivery mechanism*
  (§1: "turns events that happen elsewhere into things a user sees"), not
  arbitrary per-user UI/preference *state* — its own §2 explicitly disclaims
  "per-user notification preferences… no table is invented for it here."
  Star-nag's six fields (dismissal/cooldown/threshold/completion) are
  exactly that disclaimed shape: user preference state, not a notification
  to translate-and-deliver. `notification-service` is the right *transport*
  for the push half (§Design — subscribe/unsubscribe below), but the wrong
  *owner* of the state.
- **`tenant-service.md`** already owns exactly this shape of thing:
  `user_profiles` (§5) is 1:1-with-a-user preference/settings state, logical
  FK to `auth-service`, no cross-service calls in its hot path (§7: "zero
  outbound service calls"). Star-nag state is smaller and has no cascade/
  merge logic, but it's the same *kind* of fact — "a small piece of
  per-user state nobody else needs to join against."
- **`02-microservices-decomposition.md`**'s design principle #4 — "No
  service is a thin CRUD wrapper with no logic… folded into the closest
  service that owns related workflow logic" — is the direct rule this
  applies. A 6-column, no-cascade, no-cross-service-call table is not worth
  its own deployable (17 services is already the count from that doc's own
  catalog; this would be an 18th for one nag card). `tenant-service` is
  "the closest service that owns related workflow logic" by the
  `user_profiles` precedent above.

**Verdict: a new `star_nag_state` table in `tenant-service`, not a new
service.** This mirrors SOL-004/SOL-005 in `missing-v1` (`accounts.*`/
`testConnection`, folded into `infra-fleet-service`'s existing `Relay`
rather than inventing a service) — same "small capability, existing owner"
shape, different existing owner.

## Domain model — `StarNagState`, one row per `(tenant_id, user_id)`

```go
// tenant-service/internal/domain/star_nag_state.go
type StarNagState struct {
    UserID                       uuid.UUID
    CompanyID                    uuid.UUID // tenant scope, same column name convention as UserProfile
    BaselineAgents               *int64
    AppVersion                   *string
    NextThreshold                int64 // default STAR_NAG_INITIAL_THRESHOLD (35), ported from backend/src/shared/constants.ts:124
    Completed                    bool
    DeferredUntil                *time.Time
    AgentValueMomentAppVersion   *string
    // ActivePrompt replaces TS's in-memory promptSession (service.ts:66) —
    // persisted because a dismiss/later/openWeb/starOrca call may land on a
    // different api-gateway/tenant-service replica than the one that served
    // the show. Nil means no prompt is currently displayed.
    ActivePrompt                 *ActiveStarNagPrompt
    UpdatedAt                    time.Time
}

type ActiveStarNagPrompt struct {
    Source            string // "threshold" | "force_show" | "agent_value_moment" | "onboarding_completed" — StarNagPromptSource, star-nag-telemetry.ts
    Mode              string // "gh" | "web" — StarNagPromptMode
    Surface           string // "card" | "toast"
    OpenedRepoTracked bool   // mirrors StarNagPromptSession.openedRepoTracked (service.ts:344-347)
    ShownAt           time.Time
}
```

```sql
-- tenant-service migrations, tenant DB (own schema, per 05-data-architecture.md)
CREATE TABLE star_nag_state (
  user_id                          UUID PRIMARY KEY,          -- logical FK -> auth.users, 1:1 like user_profiles.user_id
  company_id                       UUID NOT NULL REFERENCES companies(id),
  baseline_agents                  BIGINT,
  app_version                      TEXT,
  next_threshold                   BIGINT NOT NULL DEFAULT 35, -- STAR_NAG_INITIAL_THRESHOLD
  completed                        BOOLEAN NOT NULL DEFAULT false,
  deferred_until                   TIMESTAMPTZ,
  agent_value_moment_app_version   TEXT,
  active_prompt                    JSONB,                       -- ActiveStarNagPrompt, NULL = no prompt shown
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_star_nag_state_company ON star_nag_state(company_id);
```

RLS on `company_id`, matching `user_profiles`' own treatment
(`tenant-service.md` §5,§9). A row is lazily created on first access
(`GetOrCreate`, same as TS's `ensureStarNagBaseline` auto-initializing on
first read, `threshold-trigger.ts:15-27`), not provisioned at signup.

## API surface — 10 RPCs, one per frontend-callable method

All 10 frontend methods (`runtime-star-nag-client.ts:79-177`) call with an
empty params object — no request fields needed beyond identity (from gRPC
metadata, per `08-inter-service-communication.md`'s "never a message field"
rule):

```protobuf
// tenant.proto — additive to TenantService (tenant-service.md §3)
service TenantService {
  // ... existing RPCs ...

  rpc DismissStarNag(DismissStarNagRequest) returns (google.protobuf.Empty);
  rpc DeferStarNag(DeferStarNagRequest) returns (google.protobuf.Empty);         // "later"
  rpc CompleteStarNag(CompleteStarNagRequest) returns (google.protobuf.Empty);
  rpc DisableStarNag(DisableStarNagRequest) returns (google.protobuf.Empty);
  rpc OpenWebStarNag(OpenWebStarNagRequest) returns (google.protobuf.Empty);
  rpc StarOrcaFromNag(StarOrcaFromNagRequest) returns (StarOrcaFromNagResponse);            // { starred: bool }
  rpc ForceShowStarNag(ForceShowStarNagRequest) returns (google.protobuf.Empty);
  rpc PrepareStarNagAgentValueMoment(PrepareStarNagAgentValueMomentRequest) returns (StarNagAgentValueMomentPreparation); // { status: "ready"|"skipped", mode?: "gh"|"web" }
  rpc ShowPreparedStarNagAgentValueMoment(ShowPreparedStarNagAgentValueMomentRequest) returns (google.protobuf.Empty);
  rpc NotifyStarNagOnboardingCompleted(NotifyStarNagOnboardingCompletedRequest) returns (google.protobuf.Empty);
}
```

Every request message carries only `company_id` implicitly via gRPC
metadata (identity, same as every other `tenant-service` RPC) — `user_id`
too, since this is 1:1 per-user state, not a resource ID a caller supplies
(mirrors `GetUserProfile`'s own shape, `tenant-service.md` §3).

### Usecase sketch — one representative (`Defer`), the other 9 follow the same shape

```go
// tenant-service/internal/usecase/star_nag_actions.go
type DeferStarNag struct {
    repo StarNagStateRepository
}

func (uc *DeferStarNag) Execute(ctx context.Context, userID, companyID uuid.UUID, outcome StarNagDeferOutcome) error {
    state, err := uc.repo.GetOrCreate(ctx, userID, companyID)
    if err != nil {
        return err
    }
    if state.ActivePrompt == nil {
        // Mirrors service.ts:313-316: no active session, just clear
        // any stale visible flag and return — nothing to defer.
        return nil
    }
    nextThreshold := state.NextThreshold * 2
    state.NextThreshold = nextThreshold
    state.BaselineAgents = nil // recomputed on next threshold check — see §Explicitly out of scope
    state.DeferredUntil = ptr(time.Now().Add(3 * 24 * time.Hour)) // STAR_NAG_COOLDOWN_DAYS, service.ts:21-22
    state.ActivePrompt = nil
    if err := uc.repo.Save(ctx, state); err != nil {
        return err
    }
    return publishStarNagVisibilityChanged(ctx, userID, companyID, starNagHideEvent()) // §Design — subscribe below
}
```

`Dismiss`/`Later` both call this with a different `outcome` tag purely for
telemetry (`service.ts:307-309` — `dismiss()` is `defer('dismissed')`); the
telemetry emission itself is BUG-014's concern, not designed here — see
`MAIN_OWNED_TELEMETRY_EVENTS` in `telemetry.ts:34-38`, which already
excludes `star_nag_outcome` from the `telemetry.track` RPC path because the
old backend emits it main-process-side, same split this design preserves
(`tenant-service` calling into a Go equivalent of `track()` directly, not
through the `telemetry.track` RPC, once/if SOL-014 ships that capability).

`Complete`/`Disable` clear `active_prompt`, set `completed = true`,
`deferred_until = NULL` (`service.ts:384-391`). `OpenWeb` clears
`active_prompt` and sets `deferred_until` to a cooldown WITHOUT setting
`completed` (`service.ts:342-354` — "opening GitHub is only a handoff, not
verified star success"). `ForceShow` is unconditional — no GitHub check, no
gating beyond "not already visible" — and sets `active_prompt = {source:
"force_show", mode: "gh", surface: "card"}` then publishes a `show` event
(`service.ts:397-407`).

### `StarOrcaFromNag` and `PrepareStarNagAgentValueMoment` — the GitHub-star dependency

Both call `checkOrcaStarred()`/`runStarNagDirectStarAttempt()` in TS
(`agent-value-moment.ts:41`, `direct-star-attempt.ts` — GitHub API calls via
the local `gh` CLI in the old backend). Per `scm-integration-service.md`
and `02-microservices-decomposition.md` row 16, backend-go's SCM design is
"direct per-tenant OAuth API clients, not a CLI shell-out" — but
**`scm-integration-service` has no "check/perform star" RPC of any kind
today**, confirmed by `BUG-012` (`github.starOrca`'s own missing-v3 bug,
same root cause): `scmintegration.proto`'s 24 RPCs have no `Star`/`star`
match. `BUG-012`'s own `github.checkOrcaStarred` channel already ships the
honest interim answer for exactly this gap — `nil, nil`
(`channels_scm.go:59-70`, "a real port needs a new proto RPC + usecase, not
just wiring... null is not a stub here").

**This design depends on that gap closing, and does not re-design it** —
`BUG-012`/its `SOL-012` (assigned separately, same `missing-v3` batch) is
where a `StarRepository`/"check-starred" RPC on `ScmIntegrationService`
would be specified. Until that lands, `tenant-service`'s
`PrepareStarNagAgentValueMoment` and `StarOrcaFromNag` usecases take a
`ScmStarCheckPort` interface (usecase-level port, per
`03-clean-architecture-guidelines.md`) with a **stub adapter** returning the
same `nil`/"unknown" answer `github.checkOrcaStarred` already gives:

```go
// tenant-service/internal/usecase/ports.go
type ScmStarCheckPort interface {
    // CheckStarred returns (starred, ok) — ok=false means "unable to
    // determine" (no scm-integration-service RPC yet, or the user has no
    // linked GitHub OAuth account), mirroring checkOrcaStarred's `null`.
    CheckStarred(ctx context.Context, userID uuid.UUID) (starred bool, ok bool)
    // StarRepository performs the write. Same ok=false contract.
    StarRepository(ctx context.Context, userID uuid.UUID) (starred bool, ok bool)
}
```

With `ok == false`, `PrepareStarNagAgentValueMoment` takes the exact branch
TS takes for `starred === null` — `{status: "ready", mode: "web"}`
(`agent-value-moment.ts:48-50`) — and `StarOrcaFromNag` returns
`{starred: false}` (matching the frontend's existing "web fallback" UI
path, no error surfaced). **This means all 10 RPCs are fully shippable
today** without waiting on `SOL-012`; only the "direct GitHub star from the
nag card" action stays in its current always-web-fallback state until
`scm-integration-service` grows the real RPC, then only the adapter behind
`ScmStarCheckPort` needs to change — no `tenant-service` usecase logic
does.

## `wscompat` channels — `channels_star_nag.go`

```go
// channels_star_nag.go
package wscompat

func registerStarNagChannels(r *Registry, client tenantv1.TenantServiceClient) {
    r.Register("starNag.dismiss", starNagUnaryHandler(client.DismissStarNag))
    r.Register("starNag.later", starNagUnaryHandler(client.DeferStarNag))
    r.Register("starNag.complete", starNagUnaryHandler(client.CompleteStarNag))
    r.Register("starNag.disable", starNagUnaryHandler(client.DisableStarNag))
    r.Register("starNag.openWeb", starNagUnaryHandler(client.OpenWebStarNag))
    r.Register("starNag.forceShow", starNagUnaryHandler(client.ForceShowStarNag))
    r.Register("starNag.showAgentValueMoment", starNagUnaryHandler(client.ShowPreparedStarNagAgentValueMoment))
    r.Register("starNag.onboardingCompleted", starNagUnaryHandler(client.NotifyStarNagOnboardingCompleted))

    r.Register("starNag.starOrca", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
        resp, err := client.StarOrcaFromNag(attachTenantIdentity(ctx, id), &tenantv1.StarOrcaFromNagRequest{})
        if err != nil { return nil, err }
        return resp.GetStarred(), nil
    })
    r.Register("starNag.agentValueMoment", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
        resp, err := client.PrepareStarNagAgentValueMoment(attachTenantIdentity(ctx, id), &tenantv1.PrepareStarNagAgentValueMomentRequest{})
        if err != nil { return nil, err }
        return resp, nil // {status, mode} — matches AgentValueMomentPreparation's wire shape
    })
}

// starNagUnaryHandler is the representative sketch for the 8 empty-request/
// empty-response RPCs — every one of them takes no params and returns
// nothing on success, so a single generic wrapper avoids 8 near-identical
// Register bodies (mirrors registerBrowserRelay's own "one function, N
// registrations" shape, channels_browser.go:16-32).
func starNagUnaryHandler(call func(context.Context, *emptypb.Empty, ...grpc.CallOption) (*emptypb.Empty, error)) ChannelHandler {
    return func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
        if _, err := call(attachTenantIdentity(ctx, id), &emptypb.Empty{}); err != nil {
            return nil, err
        }
        return nil, nil
    }
}
```

(The generic-signature sketch above elides that each of the 8 RPCs actually
has its own named `XRequest` type per the proto above, not a shared
`emptypb.Empty` — real code would need either a small adapter per call or a
shared marker interface; flagged here as an implementation detail, not a
design gap.)

## Design — `starNag.subscribe`/`unsubscribe`: reuse `notification-service`'s existing push pipeline, not a new transport

Per the task brief, this must build on `channels_push.go`/`push_bridge.go`'s
existing mechanism (`StreamHandler`, `PushEvent`, `RegisterStream`,
`pipePush`) rather than inventing a new one — and it does, but the more
important reuse is one layer up: **the cross-replica delivery problem this
push needs solved is the exact one `notification-service`'s
`StreamNotifications` already exists to solve** (`notification-service.md`
§3,§7 — `api-gateway` is the gRPC *client* of that stream, stateless,
"needs no session-affinity awareness"). Building a second, parallel
in-process fan-out (like `channels_push.go`'s `ClientEventBus`) would be
wrong here: `ClientEventBus`'s own doc comment (`channels_push.go:69-81`)
explicitly scopes it to "gateway-local... NOT cross-replica... UI
convenience signaling, not state that must be consistent cluster-wide" — but
a star-nag dismiss/complete call and the open `starNag.subscribe` stream for
the same user are NOT guaranteed to land on the same `api-gateway` replica,
so that mechanism's accepted staleness would silently drop real state
transitions, not just a convenience signal.

Design:

1. **`tenant-service`'s mutating usecases publish, via the transactional
   outbox** (`05-data-architecture.md`), a new subject
   `orca.tenant.star_nag.visibility_changed` whenever `active_prompt`
   transitions — `{tenant_id, user_id, event: "show"|"hide", mode?, surface?,
   occurred_at, event_id}`, per `08-inter-service-communication.md`'s event
   conventions (schema version, dedup ID).
2. **`notification-service` subscribes to it** — one more row in its §3
   subject table, alongside `orca.task.task.completed` etc.
   `TranslateEvent` (`notification-service.md` §4,§6) turns it into a
   `NotificationEvent{Type: "star_nag_visibility", Channels: [ws],
   RecipientUserIDs: [user_id], Body: <json of {event, mode, surface}>}` —
   `NotificationEvent` is explicitly "a generic translation target... a new
   subject can be added without a schema change" (`notification-service.md`
   §3), so this is additive, not a `notification-service` redesign.
3. **`wscompat` opens a `StreamNotifications` call and filters it**,
   reusing the exact `NotificationStreamOpener` type `channels_push.go`
   already defines and the exact `RegisterStream`/`PushEvent` shape
   `registerNotificationStreamChannel` already uses:

```go
// channels_star_nag.go, continued
func registerStarNagVisibilityStreamChannel(r *Registry, opener NotificationStreamOpener) {
    r.RegisterStream("starNag.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
        stream, err := opener(ctx, id.UserID) // same opener notifications.subscribe uses — see caveat below
        if err != nil {
            return nil, err
        }
        out := make(chan PushEvent)
        go func() {
            defer close(out)
            for {
                item, err := stream.Recv()
                if err != nil {
                    return
                }
                if item.GetType() != "star_nag_visibility" {
                    continue // this filtered view only forwards star-nag frames
                }
                var payload starNagVisibilityPayload // {event, mode, surface} — unmarshal from item.GetBody()
                if jerr := json.Unmarshal([]byte(item.GetBody()), &payload); jerr != nil {
                    continue
                }
                select {
                case out <- PushEvent{Channel: "starNag.event", Args: []any{payload.toFrontendShape()}}:
                case <-ctx.Done():
                    return
                }
            }
        }()
        return out, nil
    })
}
```

`payload.toFrontendShape()` maps to exactly
`RuntimeStarNagVisibilityEvent` (`runtime-star-nag-client.ts:11-13`) —
`{type: 'show', mode, surface}` or `{type: 'hide'}`.

**Known inefficiency, flagged not hidden**: this opens a *second*
independent `StreamNotifications` gRPC stream per connection whenever both
`notifications.subscribe` and `starNag.subscribe` are active (one thin
`Recv()` loop each, both filtering the same underlying event type space).
Correct and simple; not maximally efficient. If this per-channel-filtered-
substream pattern recurs for a third push namespace, the better fix is a
single shared `StreamNotifications` call per connection with server-side or
gateway-side channel demuxing — not designed here since today there are
only two consumers.

### `starNag.unsubscribe` — an honest no-op, and why

The old TS backend's `starNag.unsubscribe` (`star-nag.ts:134-141`) exists
because *that* RPC framework has a generic, explicit subscription-lifecycle
primitive — `runtime.registerSubscriptionCleanup`/`cleanupSubscription`,
keyed by a server-issued `subscriptionId` — used by any `defineStreamingMethod`
call, so a client can end one specific subscription without closing its
whole connection.

**`wscompat` has no equivalent primitive, by design.** Grepping every
`RegisterStream`-based channel already in backend-go
(`notifications.subscribe`, `runtime.clientEvents.subscribe`) finds **zero**
matching `.unsubscribe` channels — `pipePush`'s subscription lifetime is
tied to the connection's own `ctx` (`push_bridge.go:30-37`,
"reads... until ctx is cancelled"), and ends only when the WebSocket
connection itself closes. The one channel pair that DOES have an explicit
`.unsubscribe` companion — `terminal.subscribe`/`terminal.unsubscribe`
(`channels_terminal_subscribe.go:61-71,171-182`) — needs it because a
single connection can hold *multiple concurrent* terminal subscriptions
(keyed by `ptyId:clientId`) that must be individually addressable;
`starNag.subscribe` has exactly one logical subscription per connection,
the same shape `notifications.subscribe` already has without an
`.unsubscribe` sibling.

Porting `starNag.unsubscribe` literally as a plain `ChannelHandler` that
acks `{unsubscribed: true}` without tearing anything down mid-connection is
therefore the honest interim answer — same category of "accept the call,
no-op the part that doesn't map, don't pretend it does something it can't"
`BUG-014`'s own `telemetry.track` stub already documents, just for a
protocol-shape reason instead of a missing-backend reason:

```go
r.Register("starNag.unsubscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
    return map[string]bool{"unsubscribed": true}, nil
})
```

If a real mid-connection cancel becomes necessary later, the fix is
generalizing `terminal.subscribe`'s per-`subscriptionId` cancel-registry
pattern to arbitrary `StreamHandler` channels — not designed here, flagged
as the follow-up path.

## Explicitly out of scope: the "threshold" auto-trigger has no backend-go data source

TS's `handleAgentSpawned`/`shouldShowStarNagThresholdPrompt`
(`threshold-trigger.ts`) auto-fires a "show" the moment a per-process
`StatsCollector.onAgentStarted` counter crosses `starNagNextThreshold` — no
RPC call is involved; it's driven by an in-process event stream that
doesn't exist as a concept in backend-go's target design at all. Checked
`task-service.md`, `workflow-service.md`, and every `08-inter-service-
communication.md` event subject: **no "total agents spawned" counter or
event exists anywhere in `specs/backend-go/tdd/`** — the closest concepts
(`ai-provider-service.md`'s per-account usage rollup, `usage-service.md`'s
AI-CLI session tracking) count cost/sessions, not raw "an agent was
spawned" occurrences suitable for this exact threshold semantic.

This is **not one of BUG-005's 10 methods** — `handleAgentSpawned` has no
frontend-callable counterpart at all in `runtime-star-nag-client.ts`, it's
purely internal automatic behavior. So this design ships all 10 RPCs plus
subscribe/unsubscribe fully, faithfully reproducing every method the
frontend can actually call; only the *automatic* "you've spawned 35 agents,
here's a nag" trigger has no equivalent, and can't get one without a new
`task-service`/`workflow-service` event subject this bug's scope doesn't
cover. Flagged for whoever owns that decision, same as `SOL-006`'s handling
of its own out-of-scope `agent/` capability gap — not silently dropped, not
designed here either.

## Test plan

- `tenant-service/internal/usecase/star_nag_actions_test.go` — one test per
  usecase against a fake `StarNagStateRepository`: `Defer` doubles
  `next_threshold` and sets a 3-day `deferred_until`; `Complete`/`Disable`
  set `completed=true` and clear `deferred_until`; `OpenWeb` sets
  `deferred_until` WITHOUT `completed`; `ForceShow` is a no-op when
  `active_prompt` is already set; `PrepareStarNagAgentValueMoment` returns
  `{status:"skipped"}` when `completed`/cooldown-active/already-visible,
  `{status:"ready", mode:"web"}` when `ScmStarCheckPort.CheckStarred`
  returns `ok=false` (the shippable-today path).
- `tenant-service/internal/adapter/postgres/star_nag_state_repository_test.go`
  — `GetOrCreate` lazily inserts a default row; RLS/`company_id` scoping
  rejects cross-tenant reads (per `tenant-service.md` §9's adversarial-case
  discipline).
- `notification-service`: one `translate_event_test.go` case for
  `orca.tenant.star_nag.visibility_changed` → `NotificationEvent{Type:
  "star_nag_visibility"}`.
- `channels_star_nag_test.go` — one test per unary channel against a fake
  `TenantServiceClient` (empty request in, empty/typed response mapped
  through); `starNag.subscribe` against a fake `NotificationStreamOpener`
  emitting a mixed stream of `star_nag_visibility` and unrelated
  `NotificationFrame`s, asserting only the former reach the returned
  `PushEvent` channel; `starNag.unsubscribe` asserts the ack shape and that
  it does not touch the registry (no teardown side effect to assert against
  — the honest-no-op has none by design).

## References

- `backend/src/main/star-nag/service.ts:46-408` — full `StarNagService`, the state machine this design ports
- `backend/src/main/runtime/rpc/methods/star-nag.ts:1-142` — server-mode RPC method table, `starNag.subscribe`/`unsubscribe`'s streaming-framework shape
- `backend/src/main/star-nag/agent-value-moment.ts:1-107`, `threshold-trigger.ts:1-33` — value-moment and threshold gating logic
- `backend/src/shared/types.ts:3497-3515` — the 6 persisted `GlobalSettings.ui.starNag*` fields
- `backend/src/shared/constants.ts:124` — `STAR_NAG_INITIAL_THRESHOLD = 35`
- `specs/backend-go/tdd/services/tenant-service.md` §2,§3,§5,§7 — `user_profiles` precedent this design's table shape and "zero outbound calls" default follow
- `specs/backend-go/tdd/services/notification-service.md` §2,§3,§7 — "does NOT own per-user notification preferences," `StreamNotifications`'s cross-replica-safe delivery this design reuses
- `specs/backend-go/tdd/architecture/02-microservices-decomposition.md` — design principle #4 ("no thin CRUD wrapper... folded into the closest service"), the rule this whole verdict rests on
- `specs/backend-go/tdd/architecture/08-inter-service-communication.md` — event-bus conventions, outbox pattern, "API Gateway responsibilities" §5 (WS session management)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_push.go:1-124` — `RegisterPushChannels`, `registerNotificationStreamChannel`, `ClientEventBus` (and its explicit non-cross-replica scope note this design avoids relying on)
- `backend-go/services/api-gateway/internal/adapter/wscompat/push_bridge.go:12-52` — `StreamHandler`, `PushEvent`, `pipePush`'s connection-lifetime semantics (why `.unsubscribe` has no generic teardown today)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal_subscribe.go:61-71,171-182` — the one real `.unsubscribe` precedent, and why its per-`subscriptionId` registry doesn't generalize for free
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser.go:16-32` — `registerBrowserRelay`'s "one function, N registrations" shape, mirrored by `starNagUnaryHandler`
- `specs/backend-go/bugs/missing-v3/BUG-012-github-starorca-updateprtitle-not-implemented.md` — the parallel `github.starOrca`/`ScmIntegrationService` gap this design depends on but does not re-design (see its `SOL-012`)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_scm.go:56-70` — `github.checkOrcaStarred`'s honest `nil, nil` precedent, the exact interim answer `ScmStarCheckPort`'s stub adapter mirrors
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md` — house style for flagging a real out-of-scope gap (agent/ capability there, the threshold-trigger event source here) without hand-waving it
