# TASK-017: Go event allowlist — `api-gateway/internal/adapter/telemetry/allowlist.go`

**From Solution:** SOL-014
**Priority:** P1 — blocked, not ready to start (see Depends on); independent of TASK-016 otherwise
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/telemetry/allowlist.go` (new), `backend-go/services/api-gateway/internal/adapter/telemetry/allowlist_test.go` (new)
**Depends on:** **TASK-015 — BLOCKED.** This task's own schema-validation logic doesn't depend on the identity/consent decision directly, but it exists purely to support TASK-018 (the handler that calls it), which does — do not implement or land this ahead of TASK-015 being `✅ DECIDED`, since an allowlist with nothing consuming it yet has no way to be verified end-to-end and risks encoding assumptions (e.g. which fields are PII-sensitive enough to need stricter type checks) that a settled consent/identity model might change.
**Status:** `[ ]` TODO — blocked, not ready to start

---

## Context

`channels_telemetry.go`'s current stub never decodes or validates its
`args` payload at all — "there is nowhere for this event to go yet, so
there is nothing to validate against" (`channels_telemetry.go:36-38`).
SOL-014 §2 designs the fix as a Go port of the old TS backend's
`telemetry-events.ts` Zod schema catalog: a strict, fail-closed allowlist
so an unknown or malformed event name/props shape never reaches whatever
analytics vendor TASK-018 forwards to.

## Changes to make

### Step 1 — `allowlist.go`

```go
// Package telemetry implements api-gateway's telemetry.track validation and
// vendor-forwarding — see specs/backend-go/bugs/missing-v3/solutions/
// SOL-014-telemetry-track.md. allowlist.go is the Go equivalent of the old
// TS backend's shared/telemetry-events.ts Zod schema catalog: decode-and-
// validate BEFORE anything forwards to a vendor, fail closed on anything
// unrecognized.
package telemetry

import "reflect"

// EventSchema describes one allowed telemetry.track event name's shape.
// MaxProps is a strict key-count cap (mirrors telemetry-events.ts's
// .strict() Zod schemas — extra keys are a validation failure, not
// silently dropped). PropTypes is a coarse per-field type check; a full
// port would mirror each field's exact Zod validator (enum members,
// string length, etc.), not just its Go kind — see this file's own
// "Known gap" note below.
type EventSchema struct {
	Name      string
	MaxProps  int
	PropTypes map[string]reflect.Kind
}

// allowedEvents is intentionally NOT a full port of every event in
// telemetry-events.ts on its first pass — porting the real ~30+ event
// schemas verbatim is mechanical, high-volume, low-risk-per-entry work
// best done as its own follow-up once this file's shape is reviewed and
// accepted, not inflating this task's diff. Seed with a handful of real
// events from telemetry-events.ts to prove the shape, then track "port
// the remaining events" as an explicit TODO comment here, not silently
// left incomplete.
var allowedEvents = map[string]EventSchema{
	// TODO(telemetry): port the remaining ~30 event schemas from
	// backend/src/shared/telemetry-events.ts's eventSchemas record. Each
	// entry needs: exact event name (must match the frontend's
	// EventName type verbatim), MaxProps from that schema's prop count,
	// and PropTypes for each prop's coarse Go kind. Do this as a
	// dedicated follow-up PR, not silently left at this seed set.
}

// Validate checks name against allowedEvents and props against its
// schema. Returns ok=false for: an unknown event name (fail closed, same
// as validator.ts's schema-level safeParse failing on an unrecognized
// discriminant), too many props, or any prop whose Go kind doesn't match
// PropTypes. A prop present in props but absent from PropTypes is treated
// as an extra/unknown key (same over-cap-shaped failure), consistent with
// .strict() semantics.
func Validate(name string, props map[string]any) (map[string]any, bool) {
	schema, ok := allowedEvents[name]
	if !ok {
		return nil, false
	}
	if len(props) > schema.MaxProps {
		return nil, false
	}
	for key, val := range props {
		wantKind, known := schema.PropTypes[key]
		if !known {
			return nil, false
		}
		if reflect.ValueOf(val).Kind() != wantKind {
			return nil, false
		}
	}
	return props, true
}
```

**Known gap, flagged not hidden**: `PropTypes`' coarse `reflect.Kind` check
does not enforce enum membership, string length, or nested-object shape the
way a real Zod schema does — e.g. `telemetry-events.ts` may constrain a
prop to `z.enum(['a','b','c'])`, which this Go port only checks as "is a
string," not "is one of these 3 strings." Flagged here for whoever does the
full ~30-event port (see the seed-set TODO above) to decide whether a
richer per-field validator type is worth adding, or whether the coarse
check is an acceptable v1 scope-cut — not decided in this task.

### Step 2 — `allowlist_test.go`

- A known event name + valid props round-trips (`ok == true`, `props`
  returned unchanged).
- An unknown event name is rejected.
- Over-cap prop count (more keys than `MaxProps`) is rejected.
- A prop present but not in `PropTypes` is rejected (unknown-key case).
- A prop whose value's Go kind doesn't match `PropTypes[key]` is rejected
  (e.g. a string where `reflect.Int` is expected).

## Verify

```bash
cd backend-go
go build ./services/api-gateway/...
go vet ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/telemetry/... -run TestValidate -count=1 -v
```
