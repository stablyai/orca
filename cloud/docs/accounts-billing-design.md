# Orca accounts + billing — design (v0)

Status: foundation built in `nwparker/orca-private` (branch `nwparker/accounts-billing`). Stripe TEST MODE only.
Code: `cloud/apps/billing` (Worker), desktop `src/main/billing`, `src/renderer/src/components/billing`.

## Identity — reuse Orca Cloud sign-in

- Orca already has accounts/orgs: desktop PKCE login against `login.onorca.dev` (`src/main/orca-profiles/profile-cloud-*`),
  which mints audience-scoped short-lived ES256 JWTs for other services (relay token, connector token), verified by JWKS.
- Billing follows the same pattern: new endpoint `POST /v1/desktop/auth/billing-token` on Orca Cloud auth returns
  `{ billingToken, expiresAt }`, a JWT with `aud=orca-billing`, `purpose=billing`, `sub`, `org?`, `orgRole?`, `email?`, ≤15 min.
  Billing never sees the user's access/refresh token. **Needs a change in the auth service (private orca-cloud repo).**
- Billing account = `org:<orgId>` when the token names an org, else `user:<userId>`. Only org `owner`/`admin`
  can open Checkout/Portal; any member can read entitlements.
- Users/orgs/membership/roles stay owned by auth. Billing stores only account ids.

## Why Cloudflare Worker + D1

- Extends what exists (relay-edge is a Worker; wrangler/vitest tooling already in `cloud/`).
- Separate D1 database = small blast radius: the billing Worker holds the Stripe key and has no auth/relay DB access,
  and nothing else holds the Stripe key (least privilege).
- Load is tiny (webhooks, settle-interval usage reports, entitlement reads). D1's single-writer SQLite gives atomic
  single statements + `batch()` transactions, enough for the ledger. A Durable Object per account is the upgrade
  path if we need strict per-account start-time locking (concurrency reservation).
- Cron Trigger retries the meter outbox. No new vendors.

## Data model (D1, `cloud/apps/billing/migrations/0001_init.sql`)

| Table | Purpose |
|---|---|
| `billing_accounts` | account_id → stripe_customer_id (unique) |
| `subscriptions` | mirror of Stripe sub: status, plan, seats, overage_enabled, current period |
| `stripe_events` | webhook idempotency (event id, processed_at, note) |
| `usage_events` | sandbox usage segments keyed by caller's `usageId`; weighted seconds; overage seconds fixed at insert |
| `meter_reports` | outbox of overage → Stripe meter events (pending/sent/failed, attempts) |

Plans are config, not code: Stripe price ids are Worker vars, and `BILLING_PLANS` (JSON) overrides any default in
`src/plans.ts` (label, display price, included hours, concurrency, sizes, overage cap); malformed config fails closed
(503). The desktop renders plan cards from the `plans` list the entitlements endpoint returns. Draft defaults: Pro 50 h / 2 concurrent / standard; Max 300 h / 5 / all sizes;
Team 150 h × seats pooled / 3 / standard+large. Overage spend cap per plan (Pro 100 h, Max 500 h, Team 200 h/seat).
Usage is metered in "standard seconds" (wall seconds × size weight 1/2/4). Enterprise/BYOC: out of scope (sales-led).

## Stripe integration

- **Checkout** (`POST /v1/billing/checkout {plan, seats?}`): hosted, `mode=subscription`, line items = flat plan price
  (qty=seats) + metered overage price; `payment_method_collection=always` (no free plan; optional card-required trial via
  `STRIPE_TRIAL_DAYS`); `subscription_data.metadata.account_id`. One Stripe customer per account (idempotency key
  `customer-create:<account>`). 409 if a subscription is already open — plan/seat changes go through the Portal.
- **Tax**: `STRIPE_AUTOMATIC_TAX=true` adds `automatic_tax` + `tax_id_collection` to Checkout (default off). Before
  enabling: activate Stripe Tax, set the origin address (California), product tax code for SaaS, and add
  registrations as thresholds are crossed (dashboard work, no code).
- **Customer Portal** (`POST /v1/billing/portal`): upgrade/downgrade/cancel/payment methods/invoices. Portal config
  (allowed plan switches) is set in the Stripe dashboard.
- **Webhooks** (`POST /v1/stripe/webhook`): HMAC-SHA256 verification of `Stripe-Signature` over the raw body
  (5-min tolerance, multiple `v1`, secret rotation), dedupe by event id, then **re-fetch the subscription from the API**
  (no reliance on payload order/staleness). Handles `checkout.session.completed`, `customer.subscription.*`,
  `invoice.paid`, `invoice.payment_failed` (old + new `invoice.parent` shapes). A sub is credited only if billed to the
  customer we created for that account (metadata alone is not trusted). Live-mode events are acked and ignored.
  Failures return 500 so Stripe retries.
- **Meters**: only overage is sent. Included hours are tracked by us (Team pooling can't be expressed with tiered
  Stripe prices). Overage is computed inside the INSERT from the running period total, so concurrent reports can't
  double-claim included time. Meter `orca_sandbox_seconds` (sum, by customer id); overage price $0.45/h via
  `transform_quantity.divide_by=3600, round=up`. `identifier=usageId` + Idempotency-Key dedupe retries.
  Setup: `cloud/apps/billing/scripts/stripe-test-setup.ts` (refuses non-test keys; prices via `STRIPE_SETUP_PRICES`).

## Entitlement checks

- Desktop: `GET /v1/billing/entitlements` → plan, status, seats, period, included/used/remaining/overage seconds, cap,
  limits, `canStartSandbox`, `reason`, `canManageBilling`.
- Control plane (bearer `CONTROL_PLANE_TOKEN`; service binding later):
  - `POST /v1/internal/entitlements/check {accountId, machineSize, runningSandboxes}` → `{allow, reason}`.
    Reasons: `no_subscription | subscription_inactive | payment_past_due | included_hours_exhausted |
    overage_cap_reached | machine_size_not_in_plan | concurrency_limit`.
  - `POST /v1/internal/usage {usageId, accountId, sandboxId, machineSize, startedAt, endedAt}` (segments ≤24 h, settled
    periodically per boot) → recorded, overage, whether new starts are still allowed (so the control plane can stop).
- past_due: new starts refused; running sandboxes are the control plane's call (open decision: grace period).
- Known gap: a segment reported after period end but before the renewal webhook lands counts toward the old period.

## Security

- No card data touches us (hosted Checkout/Portal only). Desktop opens only `https://checkout.stripe.com/` /
  `https://billing.stripe.com/` URLs.
- Secrets only via `wrangler secret put`: `STRIPE_SECRET_KEY` (restricted `rk_test_`: Customers W, Checkout Sessions W,
  Portal W, Subscriptions R, Meter events W), `STRIPE_WEBHOOK_SECRET`, `CONTROL_PLANE_TOKEN`. Never in git/wrangler.jsonc.
- Live-mode guard: Worker refuses `sk_live_/rk_live_` keys and live events unless `STRIPE_ALLOW_LIVEMODE=true`.
- Pinned `Stripe-Version`; strict zod bodies; size limits; redirects refused on Stripe calls; JWT `maxTokenAge` 15 m.

## Test strategy

- Flow + unit tests (`cd cloud && pnpm --filter @orca-cloud/billing test`): D1 fake over `node:sqlite` running the real
  migrations; in-memory Stripe behind `fetch` (exercises encoding, headers, idempotency); Stripe-shaped event fixtures;
  signatures generated exactly as Stripe/stripe-node do (node:crypto). Covers signature, idempotency, out-of-order,
  livemode, foreign customer, overage math, outbox retry, caps, roles, auth.
- Local workerd smoke: `wrangler d1 migrations apply --local` + `wrangler dev` (verified against real D1).
- Next, with test keys: `stripe listen --forward-to 127.0.0.1:8790/v1/stripe/webhook`, `stripe trigger` fixtures,
  Stripe test clocks for renewals/past_due, and a usage audit (our ledger vs meter event summaries).

## Open decisions

1. Final prices/included hours/overage caps (config only); trial length. 2. past_due grace for running sandboxes. 3. Team seat ↔
org member count sync (manual seats in Portal for now). 4. When to turn on Stripe Tax; invoicing for Team. 5. Billing URL
host (e.g. `billing.onorca.dev`) and return page that deep-links back to Orca.
