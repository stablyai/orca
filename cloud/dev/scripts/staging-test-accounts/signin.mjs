// Signs a staging test account in through the real desktop PKCE flow (auth-staging -> PropelAuth
// test env hosted login -> loopback callback) with headless Chromium. Never prints tokens or
// passwords.
//
//   node signin.mjs OWNER|MEMBER --print-ids
//       Own PKCE + loopback; prints the Orca user id, orgs and capability flags.
//   node signin.mjs OWNER|MEMBER --session-out <file>
//       Same, and writes the session exchange JSON (access/refresh tokens) to <file> (0600).
//   node signin.mjs OWNER|MEMBER --open-url-file <file>
//       Drives the login for a dev desktop launched with ORCA_CLOUD_DEV_OPEN_URL_FILE=<file>: waits
//       for the next authorize URL the app appends there, so the real app receives the callback.
//   node signin.mjs OWNER|MEMBER --authorize-url <url>
//       Drives the login for an authorize URL some other client built.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { AUTH_URL, DESKTOP_CLIENT_ID, account } from './common.mjs'

const [label, mode, arg] = process.argv.slice(2)
const MODES = ['--print-ids', '--session-out', '--open-url-file', '--authorize-url']
if (!['OWNER', 'MEMBER'].includes(label) || !MODES.includes(mode)) {
  throw new Error(`usage: signin.mjs OWNER|MEMBER ${MODES.join('|')} [arg]`)
}
if (mode !== '--print-ids' && !arg) throw new Error(`${mode} needs an argument`)
const { email, password } = account(label)

async function login(authorizeUrl) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(authorizeUrl)
    // PropelAuth hosted login ("Log in to Orca"): one form with a text email box, a password box
    // and a "Log in with email" submit. The labels are not wired to the inputs, so match by type.
    const form = page.locator('form', { has: page.locator('input[type="password"]') }).first()
    await form.waitFor({ timeout: 30_000 })
    await form.locator('input[type="email"], input[type="text"]').first().fill(email)
    await form.locator('input[type="password"]').first().fill(password)
    await form.locator('button[type="submit"]').first().click()
    // The hosted login redirects through auth-staging to the client's loopback callback.
    await page.waitForURL(/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//, { timeout: 60_000 })
  } finally {
    await browser.close()
  }
}

async function waitForAuthorizeUrl(file) {
  const seen = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
    const next = lines.slice(seen).find((line) => line.startsWith(`${AUTH_URL}/`))
    if (next) return next
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('no authorize URL within 5 minutes; start sign-in in the app')
}

async function ownSession() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const nonce = randomBytes(16).toString('hex')
  const localProfileId = `staging-test-${label.toLowerCase()}`
  let resolveCallback
  const callback = new Promise((resolve) => (resolveCallback = resolve))
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/auth/callback') {
      res.statusCode = 404
      res.end()
      return
    }
    resolveCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') })
    res.end('Signed in. You can close this window.')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
    const authorize = new URL(`${AUTH_URL}/v1/desktop/auth/authorize`)
    for (const [key, value] of Object.entries({
      client_id: DESKTOP_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid',
      nonce,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      local_profile_id: localProfileId
    })) {
      authorize.searchParams.set(key, value)
    }
    await login(authorize.toString())
    const got = await Promise.race([
      callback,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no callback')), 30_000))
    ])
    if (got.state !== state || !got.code) throw new Error('callback state mismatch')
    const exchange = await fetch(`${AUTH_URL}/v1/desktop/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: got.code,
        codeVerifier: verifier,
        nonce,
        redirectUri,
        state,
        localProfileId
      })
    })
    if (exchange.status !== 200) throw new Error(`session exchange ${exchange.status}`)
    return await exchange.json()
  } finally {
    server.close()
  }
}

if (mode === '--authorize-url' || mode === '--open-url-file') {
  await login(mode === '--authorize-url' ? arg : await waitForAuthorizeUrl(arg))
  console.log(`${label}: login completed; the client received the callback`)
} else {
  const session = await ownSession()
  if (mode === '--session-out') writeFileSync(arg, JSON.stringify(session), { mode: 0o600 })
  const flags = Object.entries(session.capabilities?.flags ?? {})
    .filter(([, on]) => on)
    .map(([flag]) => flag)
  console.log(
    JSON.stringify({
      label,
      userId: session.cloud?.userId,
      activeOrgId: session.cloud?.activeOrgId ?? null,
      orgs: (session.organizations ?? []).map((org) => ({
        orgId: org.orgId,
        name: org.name,
        role: org.role
      })),
      flagsOn: flags
    })
  )
}
