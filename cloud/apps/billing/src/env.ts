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

  // Price ids (price_...). Flat recurring prices per plan; Team is per seat (quantity).
  STRIPE_PRICE_PRO: string
  STRIPE_PRICE_MAX: string
  STRIPE_PRICE_TEAM: string
  // Metered price attached to the sandbox-seconds meter (overage only; see usage.ts).
  STRIPE_PRICE_OVERAGE: string
  // Billing meter event_name the overage price aggregates.
  STRIPE_METER_EVENT_NAME: string
  // Optional card-required trial length for new subscriptions.
  STRIPE_TRIAL_DAYS?: string
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

  // Sandbox control plane -> billing (usage reports, start checks). Secret; >= 32 chars.
  // Comma-separated during rotation. Replace with a service binding once the control plane is a Worker.
  CONTROL_PLANE_TOKEN: string
}
