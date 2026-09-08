# BUG-014: `telemetry.track` is registered but is a complete no-op — no analytics event ever reaches a backend

**Status:** STUB — channel accepts every call and returns success; the payload is discarded, undecoded, unvalidated, and forwarded nowhere.
**Severity:** Low

---

## Summary

`telemetry.track` is registered in `wscompat` and every frontend call to it
succeeds (no error surfaced), but the handler's entire body is
`return nil, nil` — it never decodes the event name/props it was given, and
there is no analytics backend (PostHog or otherwise) anywhere in backend-go
for it to forward to. This is called out as a deliberate interim decision in
the file's own doc comment, not an oversight, but it means 100% of product
analytics events are silently dropped, and is worth tracking as a real gap
rather than assuming it's covered elsewhere.

## What's wired (proof the channel is registered)

- Registration: `backend-go/services/api-gateway/internal/adapter/wscompat/channels_telemetry.go:24`
  ```go
  func registerTelemetryChannels(r *Registry) {
  	r.Register("telemetry.track", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
  ```
- `registerTelemetryChannels` is reachable from the same channel-registration
  composition root every other real channel in this package uses, so a naive
  "is `telemetry.track` wired?" check (grep for `.Register("telemetry`) says
  yes.

## What's stubbed

- `channels_telemetry.go:24-29` — the entire handler body:
  ```go
  r.Register("telemetry.track", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
  	// Args ({name, props}) are intentionally not decoded — there is
  	// nowhere for this event to go yet, so there is nothing to validate
  	// against. See this file's package doc comment.
  	return nil, nil
  })
  ```
  `args` (the event `{name, props}` payload) is never unmarshaled, never
  validated, and never forwarded to any downstream system.
- The file's package doc comment (`channels_telemetry.go:1-15`) confirms
  this is deliberate and explains why: the old TS backend forwarded
  `telemetry.track` events to PostHog with consent-gating and cohort
  enrichment (`backend/src/main/runtime/rpc/methods/telemetry.ts` →
  `backend/src/main/telemetry/client.ts`); porting that real external
  integration is explicitly called "out of scope here."

## What the frontend actually needs (and doesn't get)

`frontend/src/renderer/src/lib/telemetry.ts`'s `track()` calls this RPC
fire-and-forget for product-analytics events throughout the app. The
frontend itself never notices the drop — every call site already treats a
failed/missing `telemetry.track` as non-fatal (console.warn only, per that
file's own doc comment) — so there's no user-visible symptom. The real
consequence is invisible to any test or manual QA pass: **zero product
analytics data reaches any backend today**, whereas the old TS backend's
equivalent path had real consent resolution, cohort enrichment, and a
PostHog client behind it.

## Why this is worth filing despite being "intentional"

An intentional no-op is still a functional gap from the product's point of
view — analytics-driven decisions (feature adoption, funnel drop-off,
error-rate monitoring via events) currently have zero backend-go data to draw
on, and nothing in the codebase currently tracks this as a follow-up item
outside this file's own comment. Filing it here makes the gap discoverable
without having to read this specific file's header.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_telemetry.go:1-30` (full file)
- `frontend/src/renderer/src/lib/telemetry.ts` (`track()` call sites, fire-and-forget contract)
- Old TS backend precedent: `backend/src/main/runtime/rpc/methods/telemetry.ts`, `backend/src/main/telemetry/client.ts` (referenced in the Go file's doc comment; not verified to still exist in this checkout since backend-go is the rewrite target)
