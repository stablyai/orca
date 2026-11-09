// Billing Worker bindings. Secrets are set with `wrangler secret put` (stdin), never in
// wrangler.jsonc or git. Deployed environments live in the private deploy config.
export type Env = {
  BILLING_DB: D1Database

  // Stripe. Use a RESTRICTED key (rk_test_...) scoped to: Customers write, Checkout Sessions
  // write, Customer portal write, Subscriptions read, Billing meter events write. Nothing else.
  STRIPE_SECRET_KEY: string
  // Webhook endpoint signing secret(s), comma-separated during rotation (whsec_...).
  STRIPE_WEBHOOK_SECRET: string
  // Pinned so a dashboard default-version bump cannot change payload shapes under us.
  STRIPE_API_VERSION?: string
  // Must be exactly 'true' to accept live-mode keys or events. Unset everywhere until launch.
  STRIPE_ALLOW_LIVEMODE?: string
  // Overrides the Stripe API origin (tests and stripe-mock only).
  STRIPE_API_BASE?: string

  // Team seat prices (price_...), quantity = seats.
  STRIPE_PRICE_TEAM_MONTHLY: string
  STRIPE_PRICE_TEAM_ANNUAL: string
  // Monthly metered price on the sandbox-seconds meter, added to a subscription when an admin
  // opts in to overage (see overage.ts, usage.ts).
  STRIPE_PRICE_OVERAGE: string
  // Billing meter event_name the overage price aggregates.
  STRIPE_METER_EVENT_NAME: string
  // Customer portal configuration (bpc_...) allowing seat changes, monthly<->annual and cancel.
  STRIPE_PORTAL_CONFIGURATION?: string
  // 'true' turns on Stripe Tax in Checkout (automatic_tax + tax id collection). Requires Stripe Tax
  // to be activated with an origin address and registrations in the dashboard. Default off.
  STRIPE_AUTOMATIC_TAX?: string

  // Optional JSON overriding any field of the default plan catalog (src/plans.ts), e.g.
  // {"pro":{"priceLabel":"$20/mo","includedHoursPerSeat":40}}. Malformed JSON fails closed (503).
  BILLING_PLANS?: string

  // Where Checkout and the portal send the browser back (a page that deep-links into Orca).
  BILLING_RETURN_URL: string

  // Desktop tokens: short-lived ES256 JWTs minted by Orca Cloud auth with aud=BILLING_JWT_AUDIENCE.
  // BILLING_JWKS (inline set) is for local dev and tests only.
  BILLING_JWKS_URL?: string
  BILLING_JWKS?: string
  BILLING_AUTH_ISSUER?: string
  BILLING_JWT_AUDIENCE: string
  // 'dev' | 'prod'. Dev may also accept BILLING_DEV_JWKS (issuer 'orca-billing-dev-test', a secret
  // operator key set for e2e runs before auth mints billing tokens); prod never does.
  BILLING_ENV?: string
  BILLING_DEV_JWKS?: string
  // Dev only: also trust Orca Cloud auth STAGING (its JWKS URL + issuer) so team/billing flows can be
  // exercised against a non-production auth. Both must be set; ignored when BILLING_ENV is 'prod'.
  BILLING_STAGING_JWKS_URL?: string
  BILLING_STAGING_AUTH_ISSUER?: string

  // Sandbox control plane -> billing (usage reports, start checks). Secret; >= 32 chars.
  // Comma-separated during rotation. Replace with a service binding once the control plane is a Worker.
  CONTROL_PLANE_TOKEN: string
  // Shared secret between Orca Cloud auth and billing for membership: auth pushes member counts to
  // POST /v1/internal/seats, billing pulls them from AUTH_INTERNAL_URL. >= 32 chars; comma-separated
  // during rotation (billing sends the first).
  MEMBERSHIP_SYNC_TOKEN?: string
  // Auth origin serving POST /v1/internal/billing/org-members. Unset: seats come from pushes and the
  // Checkout request only (local dev).
  AUTH_INTERNAL_URL?: string
}
