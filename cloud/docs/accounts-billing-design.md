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
- Users/orgs/membership/invites stay owned by auth (provider roster: PropelAuth). Billing stores only account ids.
- **Live role:** the billing-token route re-reads the caller's role from the live provider roster
  (stablyai/orca-cloud#690; before it, the role came from a mirror that rebuilds only at sign-in). Billing also
  requires checkout/portal/overage to use a token minted in the last 6 minutes, so a demotion or removal stops
  billing actions within that window.

## Team seats follow membership

- **Source of truth:** auth's provider roster. Seats = members; pending invites never count; never fewer than 1.
- **Pull:** `POST {AUTH_INTERNAL_URL}/v1/internal/billing/org-members {orgId}` → `{orgId, members}` (shared secret
  `MEMBERSHIP_SYNC_TOKEN`). Billing pulls at Checkout (the quantity ignores the desktop's request) and on the
  10-minute cron (`reconcileSeats`), which also picks up invites accepted at the provider.
- **Push:** auth calls `POST /v1/internal/seats {accountId, members}` after Orca-side removals (best effort).
- **Fail closed:** if auth is configured but unreachable, Checkout answers 503 `membership_unavailable`; malformed or
  missing counts are 400; nothing ever bills 0 seats. No token claim carries a count (tokens can be stale).
- **Proration:** see "Seat fairness" below (peak seats; adds charged now, removals at renewal).
- Desktop: Settings → Orca account → Team (also "Team" in the account menu): members with roles, invite by email
  (accepted at the sign-in provider), change role, remove (with confirm), revoke invites; owners/admins only,
  mirroring auth's role rules.

## Seat fairness and abuse resistance (decision)

How others bill seats: GitHub charges added seats immediately, prorated, and applies removals at the
next billing cycle with no refund (docs: "Impact of changing your plan on billing"). Cursor charges
adds prorated but treats remove-then-re-add as a brand-new seat, which customers report as
double-charging. Slack's Fair Billing Policy credits inactive members automatically. Linear charges
everyone not suspended at renewal and prorates later additions.

**Decision: seats billed = the period's peak membership** (GitHub model plus churn protection):
- **Adds** above the seats already paid this period are invoiced and charged now (`always_invoice`).
- **Removals** never credit mid-period. Seats drop to the member count only at renewal: within
  `seatTrueDownHours` (6 h, config) of the period end, billing lowers the quantity with
  `proration_behavior: none` (cron every 10 min, or the next membership push), so the renewal
  invoice bills the smaller team. If the cron misses the window, the org renews at the peak and is
  corrected at the following renewal (errs toward charging what was used).
- **Re-adding** someone removed earlier in the period is free. Membership up to the peak is already
  paid, so remove/re-add churn can neither dodge charges nor double-charge honest teams.
- **Included hours and caps derive from billed seats**, not raw membership. Adding members never
  grants hours or concurrency the org hasn't paid for, and the paid peak keeps its hours until renewal.
- **Per-member concurrency:** at most 3 running sandboxes per member (`member_concurrency_limit`), on
  top of the org cap of 3 × billed seats. One seat can't run the whole team's sandboxes.
- **Attribution:** usage segments carry the `userId` that started the sandbox (`usage_events.user_id`)
  for per-member caps, reporting and abuse review.
- **Membership changes are rate-limited** in auth: 10 per actor and 30 per org per minute
  (stablyai/orca-cloud#692). **The last owner is protected:** owners can't remove or demote
  themselves and admins can't act on owners, so an org always keeps an owner (pinned by tests there).
- **Org switching can't double-dip:** hours belong to the org account the sandbox was started under
  (the control plane's token names it). A person in two orgs is a seat in both and each pays, and a
  personal account is its own one-seat plan.
- **No free trial or free plan**, and Checkout always collects a card, so throwaway orgs get nothing
  for free.
- **Seat counts never come from the client:** Checkout and reconcile read auth's live count
  (pull-only in production for now, stablyai/orca-cloud#691). Missing or malformed counts are
  rejected, and seats are never below 1.

## Desktop: Team page, upgrade moments, checkout (decision)

**Checkout = Stripe hosted Checkout in the system browser, followed in-app.** Options weighed:
- *Embedded Checkout in an Electron window*: looks in-app, but there is no URL bar to verify (it trains users to type
  cards into chrome-less windows), Apple Pay does not work in Electron/Chromium, password-manager and browser card
  autofill are missing, and it needs Stripe.js under a relaxed CSP plus a hosted page anyway.
- *Stripe Elements*: same Electron limits, plus we own the PaymentIntent/subscription confirmation and 3DS edge cases.
- *Hosted Checkout in the browser* (chosen): PCI SAQ A (no card data near Orca), Apple Pay/Link/autofill, 3-D Secure
  handled by Stripe, a verifiable `checkout.stripe.com` URL, no CSP change in the app.
The in-app half: "Continue to checkout" turns the plans dialog into a checkout panel (order summary, "Finish payment in
your browser", Reopen/Cancel). It polls the entitlement every 2 s for 3 min (then "Keep waiting"), and the Worker's
`/return` page opens `orca://billing/return?checkout=success|cancel` (also `?portal=return`) so Orca comes to the front
and reacts at once. Paid → a short check → the Team page with a one-time "You're on Team" card (Create a cloud
workspace / Invite teammates). Canceled → "Nothing was charged". `incomplete`/`past_due` first invoice → "Your payment
needs one more step". The return page is static per outcome, no scripts, strict CSP.

**Team page** (account menu → Team; Settings → Orca account links to it): team mark and name, plan + seats card (seats
paid / in use, interval, next invoice estimate = renewal seats × price, before tax), or "Upgrade to use Orca Cloud" when
there is no plan; multi-email invite (paste lists, `Name <email>` lines; invalid entries stay as red chips) with seat
impact copy computed client-side from the peak-seat rules ("When alex accepts, they add a seat: $23.96 prorated that
day, then $50/month", or "Covered: uses a seat you already paid for"); members and invites in one list with status
(Active / Pending sign-in / Invited), inline role select, row menu (Make owner…, Remove…, Resend/Revoke invite, Leave
team…). Changes are optimistic per row with rollback + the reason on the row, and toasts with Undo (role, revoke).
Members see a read-only view. Personal accounts get "Create a team" and a list of teams to switch to.
Ownership transfer is auth's two-step model: an owner makes someone an owner, then that person changes the old
owner's role (auth refuses self role changes and the last owner leaving).

**Auth routes the desktop calls that auth does not have yet** (desktop maps a route 404 to "not available yet"):
`POST /v1/desktop/orgs {name}` → `{orgId, name}` (creator becomes owner) and `POST /v1/desktop/orgs/:orgId/members/leave`
(400 `last_owner` for the last owner). Resend invite = revoke + invite.

**Upgrade entry points:** account menu "Upgrade to Orca Cloud" (only once billing reports no plan, never while
loading), the Run-on picker's Orca Cloud row ("Upgrade" pill → plans page; members are told to ask an admin), and the
Team page card. All open the plans page.

## Payment failure

- On `invoice.payment_failed` (status `past_due`, later `unpaid` when retries are exhausted) billing records
  `past_due_since` (first time seen; a later failed retry does not restart it).
- New sandbox starts stop immediately (`payment_past_due`). After `paymentGraceHours` (96 h = 4 days, config)
  running sandboxes must be suspended: reason `payment_grace_expired`, `suspendRunning: true` on
  `/v1/internal/entitlements/check` and `/v1/internal/usage`, and `GET /v1/internal/suspensions` lists every
  account past its grace (for a control-plane cron). Once the invoice is paid the status returns to `active`,
  `past_due_since` clears, and starts/resume are allowed again.
- Desktop shows a banner with the suspension date and an "Update payment method" button (Portal).
- Stripe sends the dunning emails and retries (Smart Retries) — dashboard settings, see "What the user sets".

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
  - `GET /v1/internal/suspensions` → `{accounts: [{accountId, pastDueSince, graceEndsAt}]}`.
  - Reasons: `no_subscription | subscription_inactive | payment_past_due | payment_grace_expired |
    included_hours_exhausted | overage_cap_reached | machine_size_not_in_plan | concurrency_limit`.
    Stop running sandboxes when `suspendRunning` is true (and for the reasons the control plane already stops on).

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
  annual + overage, seat add/remove proration, test-clock renewal, `invoice.payment_failed` → past_due → grace
  expiry → suspend → pay → resume (36 s grace via `BILLING_PLANS` locally), cancel. 21/21 passed locally.

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
- Same e2e run against dev: 18/18 passed (grace expiry is exercised locally; dev keeps the 96 h grace).

**Shared dev signing key.** `BILLING_DEV_JWKS` on orca-billing-dev holds two public keys: `e2e` (the original e2e
key) and `dev1` (`/tmp/vdrv/secrets/dev-jwk.json`, the key the dev sandbox control plane also trusts). Tokens use
issuer `orca-billing-dev-test`, `aud=orca-billing`, `purpose=billing`; sandbox tokens use the same key with issuer
`orca-sandbox-dev-test`, `aud=orca-sandbox`. Unpackaged desktop builds with `ORCA_BILLING_DEV_KEY_FILE=<dev-jwk.json>`
self-sign billing tokens (sub = profile user, org/orgRole from the active org's live roster); packaged builds never
read the file.

**Staging auth (dev only).** orca-billing-dev also trusts Orca Cloud auth STAGING tokens
(`BILLING_STAGING_JWKS_URL`/`BILLING_STAGING_AUTH_ISSUER` = https://auth-staging.onorca.dev; ignored when
`BILLING_ENV=prod`) and reads seat counts from staging (`AUTH_INTERNAL_URL`). Orgs staging doesn't know (operator dev
tokens) answer 404 there and fall back to the Checkout request's quantity / the stored count, in dev only.

## What the user sets

| Where | Name | Value |
|---|---|---|
| billing Worker (dev/prod) secret | `MEMBERSHIP_SYNC_TOKEN` | random ≥32 chars; same value as auth's `ORCA_CLOUD_BILLING_MEMBERSHIP_TOKEN` |
| billing Worker var | `AUTH_INTERNAL_URL` | auth origin, e.g. `https://login.onorca.dev` (after orca-cloud#690 deploys) |
| auth (Cloud Run) secret | `ORCA_CLOUD_BILLING_MEMBERSHIP_TOKEN` | same value as above |
| auth (Cloud Run) env | `ORCA_CLOUD_BILLING_INTERNAL_URL` | unset for now (pull-only, orca-cloud#691); `https://billing.onorca.dev` once production billing exists |
| sandbox-control-dev secret | `CONTROL_PLANE_TOKEN` | same value as billing dev's `CONTROL_PLANE_TOKEN` |
| sandbox-control-dev var | `BILLING_URL` | `https://orca-billing-dev.lovecast.workers.dev` (and drop `ENTITLEMENTS_MODE=stub`) |
| Stripe dashboard (test, then live) | Billing → Revenue recovery | Smart Retries on; "Send emails when card payments fail" on; after retries → mark subscription unpaid |

## Open decisions

1. Real Enterprise contact URL (placeholder `https://onorca.dev/contact-sales`). 2. When to enable Stripe Tax.
