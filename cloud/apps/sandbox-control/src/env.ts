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
  /** Default region for new sandboxes (default pdx1); see regions.ts. */
  VERCEL_REGION?: string
  /** Comma list tried in order when the default region's create fails on capacity (default `iad1`; "" = none). */
  VERCEL_FALLBACK_REGIONS?: string
  /** Overrides the Vercel API origin (tests only). */
  VERCEL_API_BASE?: string
  /** Seed golden image (orcad + agent CLIs), adopted when its region has none yet; see image/. */
  GOLDEN_SNAPSHOT_ID?: string
  /** Region GOLDEN_SNAPSHOT_ID was taken in (default iad1); other regions build their own first image. */
  GOLDEN_SNAPSHOT_REGION?: string
  /** Non-prod only: pin this image over the rotated active one (preview versions testing new VM entry points). */
  GOLDEN_SNAPSHOT_OVERRIDE?: string
  /** 'off': no automatic environments (auto-environments.ts); creates without one keep cloning. */
  AUTO_ENVIRONMENTS?: string
  /** Git as the sender: `on`, `accounts:<id>,<id>` or off (default). See memberGitEnabled in index.ts. */
  MEMBER_GIT_IDENTITY?: string
  /** How long after a member's own send their GitHub identity stays usable (default 30). */
  MEMBER_GIT_WINDOW_MINUTES?: string
  /**
   * Who sees a member's daily activity heatmap on their profile. `opt_in` (default): only members
   * who turned on "Pokes and activity". `team`: every teammate (Conductor's default). Config only,
   * so flipping it needs no migration.
   */
  TEAMMATE_ACTIVITY_SHARING?: string
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
  /** Accepted `iss` values, comma-separated (a single issuer is a one-item list). */
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
  /** Durable Object that advances environment builds on alarms (EnvironmentBuildRunner, hosted by the build runner Worker: src/build-runner.ts). */
  ENV_BUILD_RUNNER?: DurableObjectNamespace
  CONTROL_PLANE_TOKEN?: string
  /** `stub` allows every start and records nothing: local dev only, refused when SANDBOX_ENV=prod. */
  ENTITLEMENTS_MODE?: string
  /** Dev only: route `dev:*` accounts through billing instead of bypassing it. */
  SANDBOX_DEV_BILLING_PASSTHROUGH?: string
  /** Dev only: dev accounts with this prefix (e.g. `dev:billing-test-`) are not exempt from billing. */
  SANDBOX_DEV_BILLING_ENFORCE_PREFIX?: string

  /**
   * ENV-STALE: each golden build's orcad + in-VM CLI as a commit-pinned bundle (runtime-bundles.ts); booting
   * sandboxes whose orcad is behind the active golden install it. Absent = images stay frozen as before.
   */
  RUNTIME_BUNDLES?: R2Bucket
  /** `off`: kill switch for the boot-time orcad refresh (bundles still publish). */
  RUNTIME_REFRESH?: string
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
  // keeps older rows readable until POST /v1/internal/secrets/rewrap has moved them to the active
  // KEK; GET /v1/internal/secrets/kek says when a retired id is no longer referenced and can be
  // dropped (src/secrets-rewrap.ts). Without SECRETS_KEK the /v1/secrets routes answer 503 and
  // sessions start without injected secrets.
  SECRETS_KEK?: string
  SECRETS_KEK_ID?: string
  SECRETS_KEK_RETIRED?: string
  /**
   * `kms`: the KEKs are held encrypted by a Google Cloud KMS key and unwrapped once per isolate
   * (src/secrets-kms.ts). Unset (default): SECRETS_KEK / SECRETS_KEK_RETIRED above, unchanged.
   * With `kms`, SECRETS_KEK and SECRETS_KEK_RETIRED are ignored, and a KMS failure answers 503
   * `secrets_unavailable` (sessions do not start without their secrets).
   *   SECRETS_KMS_KEY              projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>
   *   SECRETS_KMS_SERVICE_ACCOUNT  (secret) service-account JSON allowed to decrypt with that key only
   *   SECRETS_KEK_WRAPPED          base64 KMS ciphertext of the active KEK's 32 bytes, AAD `orca-secrets-kek:<id>`
   *   SECRETS_KEK_RETIRED_WRAPPED  JSON {"<id>":"<base64 KMS ciphertext>"} after a rotation
   */
  SECRETS_KEK_SOURCE?: string
  SECRETS_KMS_KEY?: string
  SECRETS_KMS_SERVICE_ACCOUNT?: string
  SECRETS_KEK_WRAPPED?: string
  SECRETS_KEK_RETIRED_WRAPPED?: string
  /**
   * `v1` (default) | `v2`: the row format new secrets are sealed in (src/secrets-crypto.ts). With
   * v2 a KEK rotation re-wraps data keys only. Set it only once every Worker version that reads this
   * database (previews and the rollback target included) can read v2: older code skips v2 rows.
   */
  SECRETS_SEAL_FORMAT?: string
  /**
   * Model API keys (Anthropic, OpenAI, AI Gateway, custom provider) reach the VM as placeholders and
   * the egress proxy swaps the real key in (forwardURL path). Unset or `on` (default): every account;
   * `accounts:<id>,<id>`: only those; `off`: plain env injection. Needs EGRESS_PROXY_URL.
   */
  SECRETS_EGRESS_PLACEHOLDERS?: string
  /** Per-team kill switch (comma account ids): those accounts get plain env injection. */
  SECRETS_EGRESS_PLACEHOLDERS_OFF?: string
  /** Flag S1 (`on`): Claude via the person's Orca account (setup-token store + egress swap, contract D10/D11). */
  AGENT_ACCOUNTS_CLAUDE?: string
  /** `1`: kill switch for S1 (agents fall back to keys, or sign in inside the sandbox). */
  AGENT_ACCOUNTS_CLAUDE_DISABLED?: string
  /** Flag S2 (`on`): Codex via the account broker. */
  AGENT_ACCOUNTS_CODEX?: string
  /** `1`: kill switch for S2. */
  AGENT_ACCOUNTS_CODEX_DISABLED?: string

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
  /**
   * Auth's bearer for its own pushes only: POST /v1/internal/org-members/removed (PropelAuth
   * offboarding and Orca-side removals), POST /v1/internal/members/role-changed (a role changed in
   * Orca or by a customer's identity provider) and deleting a team. Secret, >= 32 chars; lets auth
   * push without holding the operator token. The operator token is still accepted on those routes.
   */
  MEMBER_REMOVED_TOKEN?: string
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
  /** PARITY-DOCKER: 'off' turns Docker off in every workspace (the `docker` shim refuses). Default on. */
  SANDBOX_DOCKER?: string
  /** Comma list of Orca platform egress hosts every VM may reach (default `*.onorca.dev`). */
  ORCA_PLATFORM_HOST_SUFFIXES?: string
  /** Workspace sandbox egress preset: `open` (default, any host) or `limited` (fail-closed allowlist). */
  SANDBOX_EGRESS_PRESET?: string
  /** GitHub App webhook secret (secret): verifies X-Hub-Signature-256 on /v1/github/webhook. */
  GITHUB_WEBHOOK_SECRET?: string
  /**
   * Origin of the cloud setup pages (Orca Cloud auth, e.g. https://auth-staging.onorca.dev). After a
   * GitHub install started by a setup session, the browser goes to <origin>/cloud/setup/next.
   */
  CLOUD_SETUP_ORIGIN?: string
  /**
   * Origin of Orca Cloud auth's internal API (https), asked whether someone is in a team before a
   * workspace is handed to them (team-membership.ts). Its own setting, so changing the setup pages'
   * origin can never redirect an authorization call. Unset: every hand-off is refused (503).
   */
  AUTH_INTERNAL_ORIGIN?: string
  /** Archived workspaces are destroyed this many days after archive (default 30). */
  ARCHIVE_TTL_DAYS?: string
  /** Idle minutes before a sandbox sleeps (default 15; keep equal to billing's plan idleSleepMinutes). */
  IDLE_SLEEP_MINUTES?: string
  /** Status-panel cost estimate, cents per running hour by machine size: {"standard":75}. */
  COST_CENTS_PER_HOUR?: string
}
