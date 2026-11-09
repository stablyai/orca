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
  /** Service binding to the billing Worker; Workers on one account cannot reach each other over workers.dev. */
  BILLING?: Fetcher
  CONTROL_PLANE_TOKEN?: string
  /** `stub` allows every start and records nothing: local dev only, refused when SANDBOX_ENV=prod. */
  ENTITLEMENTS_MODE?: string
  /** Dev only: route `dev:*` accounts through billing instead of bypassing it. */
  SANDBOX_DEV_BILLING_PASSTHROUGH?: string

  /** Public URL of this Worker's /v1/egress/proxy; Vercel forwardURL rules point here. */
  EGRESS_PROXY_URL?: string
  /** Shortened session deadline (ms) for staging rollover rehearsals; refused when SANDBOX_ENV=prod. */
  SESSION_DEADLINE_MS?: string
  /** Dev-only: Authorization the egress proxy injects for api.github.com until the GitHub App minter exists. */
  EGRESS_DEV_STATIC_AUTHORIZATION?: string

  // GitHub App (contents/pull_requests write, metadata read, org members read). The PKCS#8 key is a secret.
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string

  // Secret store (src/secrets.ts). SECRETS_KEK is a base64 32-byte AES key (secret); SECRETS_KEK_ID
  // names it (default `k1`). After a rotation, SECRETS_KEK_RETIRED (secret, JSON {"<id>":"<b64>"})
  // keeps older rows readable. Without SECRETS_KEK the /v1/secrets routes answer 503 and sessions
  // start without injected secrets.
  SECRETS_KEK?: string
  SECRETS_KEK_ID?: string
  SECRETS_KEK_RETIRED?: string
  /**
   * `on`: Anthropic/OpenAI API keys reach the VM as placeholders and the egress proxy swaps the real
   * key in (forwardURL path). Anything else: plain env injection. Needs EGRESS_PROXY_URL.
   */
  SECRETS_EGRESS_PLACEHOLDERS?: string

  /** App slug for the install URL (github.com/apps/<slug>). */
  GITHUB_APP_SLUG?: string
  /** OAuth credentials of the same app: prove who installed it before binding (secret: CLIENT_SECRET). */
  GITHUB_APP_CLIENT_ID?: string
  GITHUB_APP_CLIENT_SECRET?: string
  /** HMAC key for the signed connect state (secret, >= 32 chars). */
  GITHUB_STATE_SECRET?: string

  /** Operator routes (/v1/internal/*): kill switch, drain, bindings. Secret, >= 32 chars; unset = no routes. */
  OPERATOR_TOKEN?: string
  /** `true` refuses every create/resume/rollover (static kill switch; the D1 flag is the runtime one). */
  SANDBOX_CREATES_DISABLED?: string
  /** Global cap on active sandboxes across all accounts (default 50). */
  SANDBOX_MAX_RUNNING?: string
  /** Per-account active cap per paid seat (default 3); billing enforces the plan limit as well. */
  ACCOUNT_MAX_ACTIVE_PER_SEAT?: string
  /** POST /v1/sandboxes per account per minute (default 10). */
  CREATE_RATE_PER_MINUTE?: string
  /** Days data is kept after cancel/unpaid before deletion (default 30). */
  DATA_RETENTION_DAYS?: string
  /** Days a suspended sandbox may sit untouched before deletion (default 90). */
  IDLE_RETENTION_DAYS?: string
  /** Hours an orphan provider resource is kept (suspended) before deletion (default 24). */
  ORPHAN_GRACE_HOURS?: string
  /** Provider snapshot expiry after last use, days (default 104, backstop behind idle retention). */
  SNAPSHOT_EXPIRATION_DAYS?: string
}
