import { execFileSync } from 'node:child_process'

// Use gcloud after setup-gcloud: it handles federated STS/impersonation and ADC refresh without dependencies or repo-local code in this duplicated action. Actions/Blacksmith runners have no metadata server.

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
