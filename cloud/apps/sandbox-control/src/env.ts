// Sandbox control-plane bindings. Secrets are set with `wrangler secret put` (stdin), never in
// wrangler.jsonc or git. Deployed environments live in the private deploy config.
export type Env = {
  SANDBOX_DB: D1Database
  /** `prod` | `dev` | `local`; tagged on every provider resource so environments never mix. */
  SANDBOX_ENV: string

  // Vercel: Orca's own Pro team. A team-scoped token limited to Sandbox; users never see it.
  VERCEL_TOKEN?: string
  VERCEL_TEAM_ID?: string
  VERCEL_PROJECT_ID?: string
  VERCEL_REGION?: string
  /** Overrides the Vercel API origin (tests only). */
  VERCEL_API_BASE?: string
  /** Golden image (orcad + agent CLIs) every new sandbox boots from; see image/. */
  GOLDEN_SNAPSHOT_ID?: string

  // Desktop tokens: short-lived ES256 JWTs from Orca Cloud auth, aud=SANDBOX_JWT_AUDIENCE.
  // SANDBOX_JWKS (inline set) is for local dev and tests only.
  SANDBOX_JWKS_URL?: string
  SANDBOX_JWKS?: string
  SANDBOX_AUTH_ISSUER?: string
  SANDBOX_JWT_AUDIENCE: string
  /** Dev-only operator key set (issuer `orca-sandbox-dev-test`); ignored when SANDBOX_ENV=prod. */
  SANDBOX_DEV_JWKS?: string

  // Billing Worker (entitlement checks + usage). CONTROL_PLANE_TOKEN is shared with it.
  BILLING_URL?: string
  CONTROL_PLANE_TOKEN?: string
  /** `stub` allows every start and records nothing: local dev only, refused when SANDBOX_ENV=prod. */
  ENTITLEMENTS_MODE?: string

  /** Public URL of this Worker's /v1/egress/proxy; Vercel forwardURL rules point here. */
  EGRESS_PROXY_URL?: string
  /** Shortened session deadline (ms) for staging rollover rehearsals; refused when SANDBOX_ENV=prod. */
  SESSION_DEADLINE_MS?: string
  /** Dev-only: Authorization the egress proxy injects for api.github.com until the GitHub App minter exists. */
  EGRESS_DEV_STATIC_AUTHORIZATION?: string
}
