import { execFileSync } from 'node:child_process'

// DESIGN CHOICE: shell out to `gcloud auth print-access-token` instead of exchanging the
// external_account credentials file that google-github-actions/auth writes.
//
// Every workflow on the Cloud SQL rollout lease already runs google-github-actions/setup-gcloud
// right after auth (verified across all 11 mutating members), so gcloud is on PATH and already
// bound to the federated identity. Doing the exchange ourselves would mean reimplementing the STS
// token swap plus the service-account impersonation leg, in an action that must stay
// zero-dependency and is duplicated by hand into a second repo. gcloud already handles every ADC
// flavour and refreshes on its own. The metadata server is not an option: it does not exist on
// GitHub or Blacksmith runners.
//
// Consequence, documented in the README: the lease step MUST come after setup-gcloud.

const TOKEN_REUSE_MS = 40 * 60 * 1_000 // GCP access tokens live ~60 min; re-mint well before that.

export function createAccessTokenSource({ run = runGcloud, now = Date.now } = {}) {
  let cached = null
  return () => {
    if (cached && cached.mintedAt + TOKEN_REUSE_MS > now()) {
      return cached.token
    }
    const token = run()
    if (!token) {
      throw new Error('gcloud auth print-access-token returned an empty token')
    }
    cached = { token, mintedAt: now() }
    return token
  }
}

function runGcloud() {
  const binary = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud'
  try {
    return execFileSync(binary, ['auth', 'print-access-token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000
    }).trim()
  } catch (error) {
    // Never surface stdout; it is the token on success and noise on failure.
    const detail = String(error?.stderr ?? '').trim() || error?.message || 'unknown failure'
    throw new Error(`could not mint a GCP access token via gcloud: ${detail}`)
  }
}
