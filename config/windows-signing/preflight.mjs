if (!process.env.SIGNING_GATE_URL) {
  throw new Error('Configure SIGNING_GATE_URL before cutting signed releases')
}
const url = new URL(process.env.SIGNING_GATE_URL)
if (
  url.protocol !== 'https:' ||
  url.pathname !== '/' ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !process.env.SIGNING_GATE_APP_ID
) {
  throw new Error(
    'Configure SIGNING_GATE_URL and SIGNING_GATE_APP_ID before cutting signed releases'
  )
}
const response = await fetch(new URL('/ready', url), {
  signal: AbortSignal.timeout(30_000),
  redirect: 'error'
})
if (!response.ok) {
  throw new Error(`Signing deployment gates are not ready (${response.status})`)
}
const ready = await response.json()
const prefix = process.env.SIGNING_ENVIRONMENT_PREFIX || 'windows'
if (
  ready.repository !== process.env.GITHUB_REPOSITORY ||
  ready.appId !== process.env.SIGNING_GATE_APP_ID ||
  !['inner', 'installer'].every((stage) =>
    ready.environments?.includes(`${prefix}-${stage}-signing`)
  )
) {
  throw new Error('Signing deployment gate identity mismatch')
}
console.log(
  'Both signing environments enforce the configured GitHub App; release signing may proceed.'
)
