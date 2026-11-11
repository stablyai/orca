// ENV-STALE: a workspace booted from an environment build snapshot (or resumed from an older image) runs the
// orcad that image was built with, so VM fixes never reached it. Each golden build now publishes its orcad and
// in-VM CLI as a commit-pinned bundle; at boot and wake, a sandbox whose orcad is behind the region's active
// golden installs that bundle before orcad starts.
//   PUT /v1/runtime-bundles/<commit>.tgz?exp&sig   the golden build VM uploads (signed by the control plane)
//   GET /v1/runtime-bundles/<commit>.tgz?exp&sig   a booting sandbox downloads (short-lived signed URL)
// The bundle is served from this Worker's own host, already on every sandbox's egress allowlist. The VM never
// trusts a hash from the download: the control plane passes the expected sha256 (computed by this Worker over
// the bytes it stored) and the commit to the boot step, and any mismatch keeps the old orcad.

export type RuntimeBundleStore = {
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>
  put(key: string, value: ArrayBuffer, options: { customMetadata: Record<string, string> }): Promise<unknown>
}

export type RuntimeBundle = { commit: string; sha256: string; runtime: string }

const COMMIT = /^[0-9a-f]{40}$/
const RUNTIME = /^[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_BUNDLE_BYTES = 120 * 1024 * 1024
/** Download URLs live just long enough for one boot step. */
export const RUNTIME_BUNDLE_URL_TTL_MS = 10 * 60_000

const keyFor = (commit: string) => `runtime/${commit}.tgz`
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function sign(secret: string, method: 'GET' | 'PUT', commit: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`orca-runtime-bundle:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${method}\n${commit}\n${exp}`)))
}

export async function runtimeBundleUrl(base: string, secret: string, method: 'GET' | 'PUT', commit: string, now: number, ttlMs = RUNTIME_BUNDLE_URL_TTL_MS): Promise<string> {
  const exp = now + ttlMs
  return `${base.replace(/\/+$/, '')}/v1/runtime-bundles/${commit}.tgz?exp=${exp}&sig=${await sign(secret, method, commit, exp)}`
}

async function verified(url: URL, secret: string, method: 'GET' | 'PUT', commit: string, now: number): Promise<boolean> {
  const exp = Number(url.searchParams.get('exp'))
  const sig = url.searchParams.get('sig') ?? ''
  if (!Number.isFinite(exp) || exp < now || exp > now + 2 * 60 * 60_000) {
    return false
  }
  const want = await sign(secret, method, commit, exp)
  // Constant-time compare of equal-length hex.
  let diff = want.length ^ sig.length
  for (let i = 0; i < want.length; i++) {
    diff |= want.charCodeAt(i) ^ (sig.charCodeAt(i) || 0)
  }
  return diff === 0
}

/** What a sandbox needs to install `commit`'s orcad, or null when no bundle was published for it. */
export async function runtimeBundleFor(store: RuntimeBundleStore, commit: string): Promise<RuntimeBundle | null> {
  if (!COMMIT.test(commit)) {
    return null
  }
  const head = await store.head(keyFor(commit))
  const sha256 = head?.customMetadata?.sha256 ?? ''
  const runtime = head?.customMetadata?.runtime ?? ''
  return SHA256.test(sha256) && RUNTIME.test(runtime) ? { commit, sha256, runtime } : null
}

/** GET/PUT /v1/runtime-bundles/<commit>.tgz; null when the path isn't this route. */
export async function handleRuntimeBundleRoute(
  request: Request,
  url: URL,
  deps: { store: RuntimeBundleStore | undefined; secret: string | undefined; now: number }
): Promise<Response | null> {
  const match = /^\/v1\/runtime-bundles\/([0-9a-f]{40})\.tgz$/.exec(url.pathname)
  if (!match) {
    return null
  }
  const commit = match[1]!
  if (!deps.store || !deps.secret) {
    return new Response('not_configured', { status: 503 })
  }
  const method = request.method === 'PUT' ? 'PUT' : request.method === 'GET' ? 'GET' : null
  if (!method || !(await verified(url, deps.secret, method, commit, deps.now))) {
    return new Response('forbidden', { status: 403 })
  }
  if (method === 'GET') {
    const object = await deps.store.get(keyFor(commit))
    return object
      ? new Response(object.body, { headers: { 'content-type': 'application/gzip', 'content-length': String(object.size), 'cache-control': 'no-store' } })
      : new Response('not_found', { status: 404 })
  }
  const claimed = request.headers.get('x-orca-sha256') ?? ''
  const runtime = request.headers.get('x-orca-runtime') ?? ''
  if (!SHA256.test(claimed) || !RUNTIME.test(runtime)) {
    return new Response('invalid_request', { status: 400 })
  }
  const length = Number(request.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0 || length > MAX_BUNDLE_BYTES) {
    return new Response('too_large', { status: 413 })
  }
  const bytes = await request.arrayBuffer()
  // The stored hash is computed here over the stored bytes; the uploader's claim must agree.
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
  if (sha256 !== claimed) {
    return new Response('sha256_mismatch', { status: 400 })
  }
  await deps.store.put(keyFor(commit), bytes, { customMetadata: { sha256, runtime } })
  console.log(JSON.stringify({ event: 'runtime_bundle_stored', commit, bytes: bytes.byteLength }))
  return Response.json({ stored: true, commit, sha256 })
}

/**
 * The boot step (runs as root before orcad starts). Inputs come from the control plane only: WANT (commit),
 * SHA (expected sha256), RT (node runtime the bundle needs), URL (signed GET). Prints one result word.
 */
export const RUNTIME_REFRESH_SCRIPT = [
  'set -u',
  'R="${ORCA_ROOT:-/opt/orca}"',
  'have=$(cat $R/runtime/orcad/SOURCE_COMMIT 2>/dev/null || echo none)',
  'if [ "$have" = "$WANT" ]; then echo "current $have"; exit 0; fi',
  'if [ ! -d "$R/runtime/runtimes/node-$RT" ]; then echo "skip_runtime $have"; exit 0; fi',
  'tmp=$(mktemp -d) || { echo "skip_tmp $have"; exit 0; }',
  'trap \'rm -rf "$tmp"\' EXIT',
  'if ! curl -fsS --max-time 25 -o "$tmp/b.tgz" "$URL"; then echo "skip_download $have"; exit 0; fi',
  'if ! echo "$SHA  $tmp/b.tgz" | sha256sum -c --status; then echo "skip_sha $have"; exit 0; fi',
  'mkdir "$tmp/x" && tar xzf "$tmp/b.tgz" -C "$tmp/x" || { echo "skip_extract $have"; exit 0; }',
  '[ "$(cat "$tmp/x/runtime/orcad/SOURCE_COMMIT" 2>/dev/null)" = "$WANT" ] || { echo "skip_commit $have"; exit 0; }',
  // Swap both directories, keeping the old ones until both are in place; restore on any failure.
  'for d in orcad orca-cli; do rm -rf "$R/runtime/$d.old"; done',
  'ok=1',
  'for d in orcad orca-cli; do',
  '  if [ -d "$tmp/x/runtime/$d" ]; then mv "$R/runtime/$d" "$R/runtime/$d.old" && mv "$tmp/x/runtime/$d" "$R/runtime/$d" || ok=0; fi',
  'done',
  'if [ "$ok" != 1 ]; then',
  '  for d in orcad orca-cli; do if [ -d "$R/runtime/$d.old" ]; then rm -rf "$R/runtime/$d"; mv "$R/runtime/$d.old" "$R/runtime/$d"; fi; done',
  '  echo "skip_swap $have"; exit 0',
  'fi',
  'for d in orcad orca-cli; do rm -rf "$R/runtime/$d.old"; done',
  'echo "refreshed $have"'
].join('\n')

/** The golden build's upload step (in the build VM, after the source build): pack, hash, PUT. */
export const RUNTIME_BUNDLE_UPLOAD_SCRIPT = [
  'set -euo pipefail',
  'cd /opt/orca',
  '[ "$(cat runtime/orcad/SOURCE_COMMIT)" = "$WANT" ]',
  'rt=$(ls runtime/runtimes | sed -n "s/^node-//p" | head -1)',
  'tar czf /tmp/orca-runtime.tgz runtime/orcad runtime/orca-cli',
  'sha=$(sha256sum /tmp/orca-runtime.tgz | cut -d" " -f1)',
  'curl -fsS --max-time 120 -X PUT --data-binary @/tmp/orca-runtime.tgz -H "x-orca-sha256: $sha" -H "x-orca-runtime: $rt" -H "content-type: application/gzip" "$URL"',
  'rm -f /tmp/orca-runtime.tgz'
].join('\n')
