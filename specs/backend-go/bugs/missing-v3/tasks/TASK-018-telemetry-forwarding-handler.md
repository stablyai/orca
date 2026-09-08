# TASK-018: `telemetry.track` — stateless forwarding handler (replaces the no-op)

**From Solution:** SOL-014
**Priority:** P2 — last in this chain; blocked, not ready to start (see Depends on)
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_telemetry.go`, `backend-go/services/api-gateway/internal/adapter/telemetry/sink.go` (new), `backend-go/services/api-gateway/internal/adapter/telemetry/posthog_client.go` (new — only if TASK-015's decision confirms an external vendor at all), `backend-go/services/api-gateway/cmd/server/main.go`
**Depends on:** **TASK-015 — BLOCKED**, and TASK-016 (consent RPC), TASK-017 (allowlist). Do not start until `../decisions/DECISION-telemetry-consent-identity-model.md` is `✅ DECIDED` (all 4 questions) AND TASK-016/TASK-017 are done. This task's `pseudonymousDistinctID` sketch below is a placeholder for whatever Question 1's decided identity shape actually is — if the decision differs from "per-`(tenant_id,user_id)` pseudonymous hash," rewrite that one function, not the rest of this handler.
**Status:** `[ ]` TODO — blocked, not ready to start

---

## Context

`channels_telemetry.go`'s entire handler body today is:

```go
func registerTelemetryChannels(r *Registry) {
	r.Register("telemetry.track", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// Args ({name, props}) are intentionally not decoded — there is
		// nowhere for this event to go yet, so there is nothing to validate
		// against. See this file's package doc comment.
		return nil, nil
	})
}
```

This task replaces that body with the real decode → consent-gate → validate
→ forward pipeline SOL-014 §3 designs, once TASK-015/016/017 give it
somewhere real to check consent and something real to validate against.
Every frontend call site already treats a dropped/failed `telemetry.track`
as non-fatal (`frontend/src/renderer/src/lib/telemetry.ts`'s own doc
comment) — this handler preserves that fire-and-forget contract: malformed
input, an unknown event, or a resolve-consent failure all still `return nil,
nil` (quiet success), never an error surfaced to the caller.

## Changes to make

### Step 1 — `telemetry.Sink` port

Create `backend-go/services/api-gateway/internal/adapter/telemetry/sink.go`:

```go
package telemetry

import "context"

// Event is one validated telemetry.track call, ready to forward.
type Event struct {
	DistinctID string
	Name       string
	Props      map[string]any
}

// Sink forwards a validated Event to whatever analytics vendor TASK-015's
// decision settles on. Small and swappable so channels_telemetry.go's
// handler is unit-testable without a real network call — same shape
// _setPostHogClientForTests gives the old TS suite (client.ts:470-472),
// minus the module-level-singleton pattern (this handler gets Sink
// injected, not read from a package global).
type Sink interface {
	Capture(ctx context.Context, event Event)
}
```

If TASK-015's decision confirms PostHog (or any specific vendor) as the
real destination, add `posthog_client.go` implementing `Sink` against that
vendor's Go SDK/HTTP API in this same package — not sketched further here
since the exact vendor call shape depends on which SDK/API version is
current at implementation time; check TASK-015's decided document for the
vendor name before writing this file. If the decision is "no external
vendor yet, log only," implement a `LoggingSink` here instead and skip
`posthog_client.go` entirely.

### Step 2 — `pseudonymousDistinctID`

```go
// pseudonymousDistinctID derives Event.DistinctID per Question 1 of
// ../../../specs/backend-go/bugs/missing-v3/decisions/
// DECISION-telemetry-consent-identity-model.md — REWRITE this function to
// match whatever that document's actually-decided answer is; the hash
// below is only SOL-014's placeholder sketch (Option A: per-(tenant,user)
// pseudonymous hash), not a decided design.
func pseudonymousDistinctID(tenantID, userID string) string {
	h := sha256.Sum256([]byte(tenantID + ":" + userID))
	return hex.EncodeToString(h[:])
}
```

### Step 3 — replace `channels_telemetry.go`'s handler body

```go
// The old TS backend's telemetry.track (backend/src/main/runtime/rpc/methods/
// telemetry.ts) forwarded consent-gated product-analytics events to a
// vendor per the decision recorded in specs/backend-go/bugs/missing-v3/
// decisions/DECISION-telemetry-consent-identity-model.md. This handler
// preserves frontend/src/renderer/src/lib/telemetry.ts's fire-and-forget
// contract: every failure path below quietly acks (return nil, nil)
// rather than surfacing an error, matching that file's own doc comment.
package wscompat

import (
	"context"
	"encoding/json"
	"time"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/telemetry"
)

func registerTelemetryChannels(r *Registry, tenantClient tenantv1.TenantServiceClient, sink telemetry.Sink) {
	r.Register("telemetry.track", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		var in struct {
			Name  string         `json:"name"`
			Props map[string]any `json:"props"`
		}
		if len(args) == 0 {
			return nil, nil
		}
		if err := json.Unmarshal(args[0], &in); err != nil || in.Name == "" {
			return nil, nil
		}

		// Consent resolve — reads live tenant-service state every call,
		// never a cached boolean (see TASK-016's GetTelemetryConsent).
		consentCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		consent, err := tenantClient.GetTelemetryConsent(attachTenantIdentity(consentCtx, id),
			&tenantv1.GetTelemetryConsentRequest{UserId: id.UserID})
		if err != nil || !consent.GetHasOptedIn() || !consent.GetOptedIn() {
			// Fail closed: an error resolving consent, no recorded consent
			// yet, or an explicit opt-out are all treated identically —
			// never capture.
			return nil, nil
		}

		props, ok := telemetry.Validate(in.Name, in.Props)
		if !ok {
			return nil, nil
		}

		sink.Capture(ctx, telemetry.Event{
			DistinctID: pseudonymousDistinctID(id.TenantID, id.UserID),
			Name:       in.Name,
			Props:      props,
		})
		return nil, nil
	})
}
```

### Step 4 — `channels.go` + `main.go` wiring

`channels.go`'s `RegisterRealChannels` currently calls
`registerTelemetryChannels(r)` (no arguments) at line 136 — change the call
site to `registerTelemetryChannels(r, tenantClient, telemetrySink)`.
`tenantClient` is already a `RegisterRealChannels` parameter (used by
`registerOnboardingChannels`/`registerDevServerAccessControlChannels`
already); add `telemetrySink telemetry.Sink` as a new parameter threaded
through the same way, and construct the real (or `LoggingSink`, per Step 1)
implementation in `cmd/server/main.go` near where `wscompat.RegisterRealChannels(...)`
is called, following whatever config-driven construction pattern TASK-015's
decided vendor needs (e.g. an API key from `cfg`, or nothing at all for a
`LoggingSink`).

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestTelemetryTrack -count=1 -v
go test ./services/api-gateway/internal/adapter/telemetry/... -count=1 -v
```

Test-plan detail for `channels_telemetry_test.go` (rewrite the existing
test for the old no-op, if one exists — check for
`channels_telemetry_test.go` in this package first): fake
`TenantServiceClient` + fake `Sink` — opted-out user's event never reaches
`Sink.Capture`; a `GetTelemetryConsent` RPC error fails closed (no
capture); opted-in + valid event reaches `Sink.Capture` with the expected
`DistinctID`/`Name`/`Props`; malformed/empty `args` still ack `nil, nil`
rather than erroring. No real vendor network call in any test — `Sink` is a
fake throughout, matching the old TS suite's own reliance on
`_setPostHogClientForTests` rather than a live sandbox.
