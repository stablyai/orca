# Orca accounts + billing — design (v1)

Status: built in `nwparker/orca-private` (base branch `nwparker/accounts-billing`). Stripe TEST MODE only.
Code: `cloud/apps/billing` (Worker), desktop `src/main/billing`, `src/renderer/src/components/billing`.

## Pricing (final, all config)

| Plan | Price | Includes |
|---|---|---|
| Team | $50/seat/mo or $480/seat/yr | 60 Standard (4 vCPU / 8 GB) sandbox hours per seat per month, pooled across the org; Large (8/16) burns 2x; 3 running sandboxes per seat; 15-min idle sleep |
| Overage | opt-in, off by default | $0.75/h Standard ($1.50/h Large); monthly spend cap, default $25, admins can raise (max $5,000); warnings at 80% / 100% of included hours |
| Enterprise | Custom | "Contact us" (no Stripe price) |

No free plan, no trial, no other tiers. Numbers and labels live in `src/plans.ts` defaults and can be overridden
without a code change by `BILLING_PLANS` (JSON, validated; malformed config fails closed with 503). Stripe price
ids are Worker vars. Annual plans still get a **monthly** allowance window (a calendar-month slice of the year,
anchored on the subscription start). Stripe Tax: `STRIPE_AUTOMATIC_TAX=true` adds `automatic_tax` +
`tax_id_collection` to Checkout; default off (activate Stripe Tax with the California origin address, SaaS tax code
and registrations first).

## Identity — reuse Orca Cloud sign-in

- Desktop PKCE login against `login.onorca.dev` already mints audience-scoped short-lived ES256 JWTs for other
  services (relay, connector). Billing uses the same: `POST /v1/desktop/auth/billing-token` (**to add in the auth
  service**) returns a ≤15-min JWT, `aud=orca-billing`, `purpose=billing`, `sub`, `org?`, `orgRole?`, `email?`.
- Billing account = `org:<orgId>`, else `user:<userId>`. Only owners/admins buy, manage billing, or change overage.
- Users/orgs/membership stay owned by auth. Billing stores only account ids.

## Why Cloudflare Worker + D1

Extends the existing Workers setup (relay-edge); a separate D1 keeps the Stripe key and billing ledger isolated
from auth/relay data (least privilege); load is small; Cron Trigger retries the meter outbox. A Durable Object per
account is the upgrade path for strict per-account start locking.

## Data model (D1 migrations 0001, 0002)

| Table | Purpose |
|---|---|
| `billing_accounts` | account → Stripe customer; `overage_opt_in`, `spend_cap_cents` |
| `subscriptions` | Stripe mirror: status, seats, interval, period, overage item id |
| `stripe_events` | webhook idempotency |
| `usage_events` | usage segments keyed by caller `usageId`; weighted seconds; allowance-window start; overage fixed at insert |
| `meter_reports` | outbox of billable overage → Stripe meter events, capped at the spend cap in SQL |

## Stripe integration

- **Checkout** (`POST /v1/billing/checkout {plan:'team', interval, seats}`): hosted, `mode=subscription`, seat price
  (quantity adjustable on the page), `payment_method_collection=always`, `subscription_data.metadata.account_id`.
  One customer per account. 409 if a subscription is open (changes go through the Portal).
- **Customer Portal**: configuration `STRIPE_PORTAL_CONFIGURATION` allows seat quantity changes, monthly↔annual
  switch (prorated), cancel at period end, payment method, invoices.
- **Overage opt-in** (`POST /v1/billing/overage {enabled, spendCapCents?}`): first opt-in adds the monthly metered
  overage price to the subscription (idempotent); opting out stops metering immediately (the item stays so
  already-reported usage still invoices). Annual subscriptions accept the monthly metered item (verified).
- **Webhooks**: HMAC-SHA256 over the raw body (5-min tolerance, rotation), event-id dedupe, then re-read the
  subscription from the API (order/staleness-proof). Handles `checkout.session.completed`, `customer.subscription.*`,
  `invoice.paid`, `invoice.payment_failed` (old and new payload shapes). Credited only to the customer billing created
  for that account. Live-mode events are acked and ignored. Failures → 500 so Stripe retries.
- **Meter**: `orca_sandbox_seconds` (sum by customer); overage price $0.75/h via `transform_quantity.divide_by=3600`.
  Only billable overage is sent, at most the remaining spend cap; `identifier=usageId` + Idempotency-Key.

## Entitlements

- Desktop `GET /v1/billing/entitlements`: plan, status, interval, seats, period, monthly usage window,
  included/used/remaining, `usageWarningPercent`, overage {optedIn, active, cap, spent, rate}, limits,
  `canStartSandbox`, `reason`, `canManageBilling`, and `offers` (Team + Enterprise, for the plan cards).
- Control plane (bearer `CONTROL_PLANE_TOKEN`):
  - `POST /v1/internal/entitlements/check {accountId, machineSize: standard|large, runningSandboxes}` → `{allow, reason}`.
  - `POST /v1/internal/usage {usageId, accountId, sandboxId, machineSize, startedAt, endedAt}` (segments ≤24 h).
  - Reasons: `no_subscription | subscription_inactive | payment_past_due | included_hours_exhausted |
    overage_cap_reached | machine_size_not_in_plan | concurrency_limit`.

## Security

No card data touches us (hosted pages; desktop opens only `checkout.stripe.com` / `billing.stripe.com`, and an https
Enterprise contact URL). Secrets only via `wrangler secret put` / untracked `.dev.vars`. Worker refuses live keys and
live events unless `STRIPE_ALLOW_LIVEMODE=true`. Pinned `Stripe-Version`; strict zod bodies; size limits; redirects
never followed with the key; JWT max age 15 min.

## Tests

- Unit/flow: `cd cloud && pnpm --filter @orca-cloud/billing test` (D1 fake over node:sqlite with real migrations,
  in-memory Stripe behind fetch, Stripe-shaped fixtures, Stripe-identical signatures).
- Live TEST-mode e2e: `scripts/stripe-test-setup.ts` (catalog + portal) and `scripts/e2e-test-mode.ts run` against
  `wrangler dev` + `stripe listen --project-name orca`: Checkout with the test card for 2 seats, overage opt-in,
  usage past included hours → meter events (checked against Stripe's meter summaries), spend cap blocks starts,
  annual + overage, test-clock renewal, `invoice.payment_failed` → past_due, cancel. 14/14 passed locally.

## Dev deployment (TEST MODE, for the sandbox control plane)

- **Billing dev URL:** `https://orca-billing-dev.lovecast.workers.dev` (Cloudflare account "Stably",
  `wrangler.dev.jsonc`, `BILLING_ENV=dev`). Control plane config: `BILLING_URL=https://orca-billing-dev.lovecast.workers.dev`,
  `CONTROL_PLANE_TOKEN` = the same secret set on both Workers, and send `machineSize` `standard|large` only.
- D1 `orca-billing-dev` (`12aa0820-642a-4174-8504-f42d32043959`), migrations 0001–0002 applied.
- Stripe test webhook endpoint `we_1UZmcXKb73TzRkjkJMKg0jso` → `/v1/stripe/webhook` (API `2025-09-30.clover`).
- Secrets (stdin only): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CONTROL_PLANE_TOKEN`, `BILLING_DEV_JWKS`.
- Desktop auth: JWKS `https://login.onorca.dev/.well-known/jwks.json`, issuer `https://login.onorca.dev`. Until auth mints
  billing tokens, dev also accepts the operator key set `BILLING_DEV_JWKS` (issuer `orca-billing-dev-test`; refused
  when `BILLING_ENV=prod`).
- Same e2e run against dev: 14/14 passed.

## Open decisions

1. Seat sync with org membership (auth service must call billing on member changes). 2. past_due grace for running
sandboxes. 3. Real Enterprise contact URL (placeholder `https://onorca.dev/contact-sales`). 4. When to enable Stripe Tax.
