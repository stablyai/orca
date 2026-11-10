// Eval configuration. DEV backends only: the harness refuses prod hosts and live Stripe keys.
// Secret files are read here and never printed; results and logs carry ids and timings only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SECRETS_DIR = process.env.ORCA_EVAL_SECRETS_DIR ?? '/tmp/vdrv/secrets'
const CONTEXT_DIR =
  process.env.ORCA_EVAL_CONTEXT_DIR ??
  '/Users/nwparker/orca/workspaces/orca/cloudy-cloud-with-rain-cloudy-Cloud-cloudy-cloud-with-rain-cloudy/.context/cloud'

export const config = {
  controlPlaneUrl: process.env.ORCA_EVAL_CONTROL_URL ?? 'https://orca-sandbox-control-dev.lovecast.workers.dev',
  billingUrl: process.env.ORCA_EVAL_BILLING_URL ?? 'https://orca-billing-dev.lovecast.workers.dev',
  vercelTeamId: 'team_c5IO9DfEYAxKEUgMxrbEtO0a',
  vercelProjectId: 'prj_SkVtv6zJurF9dUHpfTRy4v9avwPq',
  /** Test repo the dev GitHub App is installed on. */
  testRepo: 'https://github.com/nwparker/orca-sandbox-push-test',
  orcaCli: process.env.ORCA_EVAL_CLI ?? '/Applications/Orca.app/Contents/Resources/bin/orca',
  contextDir: CONTEXT_DIR,
  runsDir: join(CONTEXT_DIR, 'acceptance-runs'),
  reportPath: join(CONTEXT_DIR, 'orca-cloud-evaluation-report.html'),
  secretsDir: SECRETS_DIR,
  /** Hard concurrency ceiling for sandboxes this harness holds at once (brief: ≤6). */
  maxConcurrentSandboxes: 6
}

for (const url of [config.controlPlaneUrl, config.billingUrl]) {
  if (!/(-dev\.lovecast\.workers\.dev|127\.0\.0\.1|localhost)/.test(url)) {
    throw new Error(`Refusing non-dev backend: ${url}`)
  }
}

function readSecretJson<T>(file: string): T | null {
  const path = join(SECRETS_DIR, file)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null
}

export const secrets = {
  devJwk: () => readSecretJson<{ private: JsonWebKey & { kid?: string }; public: JsonWebKey }>('dev-jwk.json'),
  operatorToken: () => readSecretJson<{ OPERATOR_TOKEN: string }>('operator-dev.json')?.OPERATOR_TOKEN ?? null,
  /** Sandbox-scoped token if present, else the authed Vercel CLI's token (read-only use + cleanup). */
  vercelToken: () =>
    readSecretJson<{ bearerToken: string }>('tok.json')?.bearerToken ??
    (() => {
      const path = join(process.env.HOME ?? '', 'Library/Application Support/com.vercel.cli/auth.json')
      return existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { token?: string }).token ?? null) : null
    })(),
  /** Shared AI Gateway key (W6; ~$5 free credit, no anthropic/* models). One tiny task per check. */
  aiGatewayKey: () => {
    const path = join(SECRETS_DIR, 'ai-gateway.key')
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
  },
  /** Billing internal routes (usage, entitlements/check, suspensions). */
  controlPlaneToken: () => readText(join(SECRETS_DIR, 'control-plane.token')),
  /** Auth -> billing membership pushes (POST /v1/internal/seats). */
  membershipToken: () =>
    process.env.ORCA_EVAL_MEMBERSHIP_TOKEN ?? readText(join(process.env.HOME ?? '', '.orca-secrets/billing-membership-token')),
  /** Optional: sk_test_/rk_test_ only. Falls back to the Stripe CLI `orca` project profile. */
  stripeKey: () => process.env.ORCA_EVAL_STRIPE_KEY ?? null
}
