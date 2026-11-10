// Direct dev control-plane calls for the desktop acceptance run: list/delete leftovers and probe
// endpoints the UI depends on. Tokens are dev-signed (ES256) with the kid from the key file.
import { readFileSync } from 'node:fs'
import { SignJWT, importJWK } from 'jose'

export const SANDBOX_URL =
  process.env.ORCA_CLOUD_SANDBOX_URL ?? 'https://orca-sandbox-control-dev.lovecast.workers.dev'
export const DEV_KEY_FILE = process.env.ORCA_CLOUD_SANDBOX_DEV_KEY_FILE ?? '/tmp/vdrv/secrets/dev-jwk.json'

export async function sandboxToken(sub) {
  const file = JSON.parse(readFileSync(DEV_KEY_FILE, 'utf8'))
  const kid = file.private.kid ?? file.kid ?? 'dev1'
  const key = await importJWK(file.private, 'ES256')
  return new SignJWT({ sub, purpose: 'sandbox' })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer('orca-sandbox-dev-test')
    .setAudience('orca-sandbox')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

export async function sandboxApi(sub, method, path, body) {
  const res = await fetch(SANDBOX_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${await sandboxToken(sub)}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text: json ? undefined : text.slice(0, 300) }
}

export async function listSandboxes(sub) {
  const r = await sandboxApi(sub, 'GET', '/v1/sandboxes')
  const items = r.json?.sandboxes ?? r.json?.items ?? (Array.isArray(r.json) ? r.json : [])
  return { status: r.status, items }
}

/** Deletes every sandbox owned by `sub` that is not already gone; returns what it did. */
export async function deleteAllSandboxes(sub) {
  const { status, items } = await listSandboxes(sub)
  const live = items.filter((s) => !/^(deleted|destroyed|deleting)$/i.test(String(s.state ?? s.status ?? '')))
  const deleted = []
  for (const s of live) {
    const r = await sandboxApi(sub, 'DELETE', `/v1/sandboxes/${encodeURIComponent(s.id)}`)
    deleted.push({ id: s.id, state: s.state ?? s.status, deleteStatus: r.status })
  }
  return { listStatus: status, seen: items.length, deleted }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd = 'list', sub = 'w9-desktop'] = process.argv.slice(2)
  if (cmd === 'list') {
    const { status, items } = await listSandboxes(sub)
    console.log(
      JSON.stringify(
        { status, items: items.map((s) => ({ id: s.id, state: s.state ?? s.status, name: s.name, createdAt: s.createdAt })) },
        null,
        1
      )
    )
  } else if (cmd === 'cleanup') {
    console.log(JSON.stringify(await deleteAllSandboxes(sub), null, 1))
  }
}
