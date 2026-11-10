// Sandbox control-plane bindings. Secrets are set with `wrangler secret put` (stdin), never in
// wrangler.jsonc or git. Deployed environments live in the private deploy config.
export type Env = {
  SANDBOX_DB: D1Database
  /** Comma-separated browser origins allowed to call /mcp besides this Worker's own (MCP web clients). */
  MCP_ALLOWED_ORIGINS?: string
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
  /** Non-prod only: pin this image over the rotated active one (preview versions testing new VM entry points). */
  GOLDEN_SNAPSHOT_OVERRIDE?: string
  /** Git as the sender: `on`, `accounts:<id>,<id>` or off (default). See memberGitEnabled in index.ts. */
  MEMBER_GIT_IDENTITY?: string
  /** How long after a member's own send their GitHub identity stays usable (default 30). */
  MEMBER_GIT_WINDOW_MINUTES?: string
  /** `release:latest` | `release:v1.2.3`: build golden images from Orca's released orca-server tarball. */
  GOLDEN_IMAGE_SOURCE?: string
  /** TTL for Worker-built golden images; unset/0 keeps them until rotated out. */
  GOLDEN_SNAPSHOT_EXPIRATION_DAYS?: string
  /** Refresh lead time before the active image expires (hours, default 24). */
  GOLDEN_REFRESH_BEFORE_HOURS?: string

  // Desktop tokens: short-lived ES256 JWTs from Orca Cloud auth, aud=SANDBOX_JWT_AUDIENCE.
  // SANDBOX_JWKS (inline set) is for local dev and tests only.
  SANDBOX_JWKS_URL?: string
  SANDBOX_JWKS?: string
  SANDBOX_AUTH_ISSUER?: string
  SANDBOX_JWT_AUDIENCE: string
  /** Dev-only operator key set (issuer `orca-sandbox-dev-test`); ignored when SANDBOX_ENV=prod. */
  SANDBOX_DEV_JWKS?: string
  /**
   * Dev only (ignored when SANDBOX_ENV=prod): also trust Orca Cloud auth STAGING sandbox tokens, as
   * billing dev does, so a staging sign-in works end to end. URL in deployments, inline set in tests.
   */
  SANDBOX_STAGING_JWKS_URL?: string
  SANDBOX_STAGING_JWKS?: string
  SANDBOX_STAGING_AUTH_ISSUER?: string

  // Billing Worker (entitlement checks + usage). CONTROL_PLANE_TOKEN is shared with it.
  BILLING_URL?: string
  /** Service binding to the billing Worker; Workers on one account cannot reach each other over workers.dev. */
  BILLING?: Fetcher
  /** Durable Object that advances environment builds on alarms (EnvironmentBuildRunner in index.ts). */
  ENV_BUILD_RUNNER?: DurableObjectNamespace
  CONTROL_PLANE_TOKEN?: string
  /** `stub` allows every start and records nothing: local dev only, refused when SANDBOX_ENV=prod. */
  ENTITLEMENTS_MODE?: string
  /** Dev only: route `dev:*` accounts through billing instead of bypassing it. */
  SANDBOX_DEV_BILLING_PASSTHROUGH?: string
  /** Dev only: dev accounts with this prefix (e.g. `dev:billing-test-`) are not exempt from billing. */
  SANDBOX_DEV_BILLING_ENFORCE_PREFIX?: string

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
   * Model API keys (Anthropic, OpenAI, AI Gateway, custom provider) reach the VM as placeholders and
   * the egress proxy swaps the real key in (forwardURL path). Unset or `on` (default): every account;
   * `accounts:<id>,<id>`: only those; `off`: plain env injection. Needs EGRESS_PROXY_URL.
   */
  SECRETS_EGRESS_PLACEHOLDERS?: string
  /** Per-team kill switch (comma account ids): those accounts get plain env injection. */
  SECRETS_EGRESS_PLACEHOLDERS_OFF?: string

  /** App slug for the install URL (github.com/apps/<slug>). */
  GITHUB_APP_SLUG?: string
  /** OAuth credentials of the same app: prove who installed it before binding (secret: CLIENT_SECRET). */
  GITHUB_APP_CLIENT_ID?: string
  GITHUB_APP_CLIENT_SECRET?: string
  /** HMAC key for the signed connect state (secret, >= 32 chars). */
  GITHUB_STATE_SECRET?: string

  /**
   * Share links (src/share-links.ts): HMAC secret (>= 32 chars) for link tokens, per-session VM
   * proxy keys and viewer cookies. Unset = share routes answer 503. Rotating it voids every link.
   */
  SHARE_LINK_SECRET?: string
  /**
   * Per-link subdomain mode: `.share.example.dev` serves `<token>.share.example.dev/` at the root
   * (needs a wildcard custom domain on this Worker). Unset = path mode `/s/<token>/` only.
   */
  SHARE_HOST_SUFFIX?: string
  /** Retired SHARE_LINK_SECRET, still accepted for links, codes and cookies while a rotation drains. */
  SHARE_LINK_SECRET_PREVIOUS?: string
  /** `on` | `off`: path-mode links (`/s/<token>/` on this origin). Default on outside prod, off in prod. */
  SHARE_PATH_MODE?: string

  /** Operator routes (/v1/internal/*): kill switch, drain, bindings. Secret, >= 32 chars; unset = no routes. */
  OPERATOR_TOKEN?: string
  /** `true` refuses every create/resume/rollover (static kill switch; the D1 flag is the runtime one). */
  SANDBOX_CREATES_DISABLED?: string
  /** Warm pool size (pool.ts); unset or 0 = off. */
  SANDBOX_POOL_SIZE?: string
  SANDBOX_POOL_MAX_AGE_MS?: string
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

  // Public API, MCP and routines (src/api, src/mcp, src/routines).
  /** Origin the in-VM CLI, docs, MCP metadata and webhook URLs use (default: the request origin). */
  PUBLIC_API_URL?: string
  /** Comma list of extra egress hosts every VM may reach (dev: this Worker's workers.dev host). */
  EGRESS_EXTRA_HOSTS?: string
  /** GitHub App webhook secret (secret): verifies X-Hub-Signature-256 on /v1/github/webhook. */
  GITHUB_WEBHOOK_SECRET?: string
  /** Archived workspaces are destroyed this many days after archive (default 30). */
  ARCHIVE_TTL_DAYS?: string
  /** Idle minutes before a sandbox sleeps (default 15; keep equal to billing's plan idleSleepMinutes). */
  IDLE_SLEEP_MINUTES?: string
  /** Status-panel cost estimate, cents per running hour by machine size: {"standard":75,"large":150}. */
  COST_CENTS_PER_HOUR?: string
}
