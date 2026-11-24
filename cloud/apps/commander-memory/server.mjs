import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { fail, openStore } from './store.mjs'

const base = '/v1/commander/memory'

function configureAuthority(value) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw Error('Configure a trusted HTTPS capabilities endpoint')
  }
  return url
}

async function accountIdentity(url, token) {
  const reply = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  })
  if ([401, 403].includes(reply.status)) fail(401, 'Account authentication required')
  if (!reply.ok) fail(503, 'Account authority unavailable')
  const { cloud } = await reply.json()
  if (
    typeof cloud?.userId !== 'string' ||
    !cloud.userId.trim() ||
    cloud.userId.length > 256 ||
    (cloud.activeOrgId != null &&
      (typeof cloud.activeOrgId !== 'string' ||
        !cloud.activeOrgId.trim() ||
        cloud.activeOrgId.length > 256))
  ) {
    fail(503, 'Account authority returned an incomplete identity')
  }
  return {
    tenant: JSON.stringify([cloud.userId, cloud.activeOrgId ?? null]),
    actor: { type: 'human', id: cloud.userId }
  }
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 512 * 1024) fail(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!body || typeof body !== 'object' || Array.isArray(body))
      fail(400, 'Expected a JSON object')
    return body
  } catch {
    fail(400, 'Expected a JSON object')
  }
}

export function createMemoryServer({ capabilitiesEndpoint, databasePath }) {
  const authority = configureAuthority(capabilitiesEndpoint)
  const store = openStore(databasePath)
  const server = createServer(async (req, res) => {
    try {
      const [path, query] = req.url.split('?')
      const action =
        path === base ? '' : path.startsWith(base + '/') ? path.slice(base.length + 1) : null
      if (action === null) fail(404, 'Unknown memory endpoint')
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1]
      if (!token) fail(401, 'A bearer credential is required')
      const preferenceRequest =
        req.method === 'POST' && ['preferences/ask', 'preferences/settings'].includes(action)
          ? await readBody(req)
          : undefined
      const identity = token.startsWith('orcacmd_')
        ? store.delegatedIdentity(token)
        : await accountIdentity(authority, token)
      let result
      if (req.method === 'GET' && !action)
        result = {
          actor: identity.actor,
          projectId: identity.projectId ?? null,
          pages: store.list(identity)
        }
      else if (req.method === 'GET' && ['index', 'handoffs-index'].includes(action))
        result = store.index(identity, new URLSearchParams(query), action === 'handoffs-index')
      else if (req.method === 'GET' && action === 'worker-guidance')
        result = store.workerGuidance(identity, new URLSearchParams(query))
      else if (req.method === 'GET' && action.startsWith('pages/')) {
        const cursor = new URLSearchParams(query).get('beforeVersion')
        result = store.history(
          identity,
          action.slice(6),
          cursor === null ? undefined : Number(cursor)
        )
      } else if (req.method === 'GET' && action.startsWith('dispatch-plans/'))
        result = store.replayPlan(identity, action.slice('dispatch-plans/'.length))
      else if (req.method === 'POST' && action === 'delegations')
        result = store.delegate(identity, await readBody(req))
      else if (req.method === 'POST' && action === 'preferences/ask')
        result = store.askPreference(identity, preferenceRequest)
      else if (action === 'preferences/settings' && ['GET', 'POST'].includes(req.method))
        result = store.preferenceSettings(identity, preferenceRequest)
      else if (req.method === 'POST' && ['human', 'agent', 'commander'].includes(action)) {
        if (identity.actor.type !== action) fail(403, 'Credential cannot write as requested actor')
        const body = await readBody(req)
        result = {
          page: store.write(identity, body),
          ...(body.replayPlan ? { planSaved: true } : {})
        }
      } else fail(404, 'Unknown memory endpoint')
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(error.status ?? 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      })
      res.end(
        JSON.stringify({ error: error.status ? error.message : 'Commander memory unavailable' })
      )
    }
  })
  server.on('close', () => store.close())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077)
  createMemoryServer({
    capabilitiesEndpoint: process.env.ORCA_AUTH_CAPABILITIES_ENDPOINT,
    databasePath: process.env.ORCA_COMMANDER_MEMORY_DB ?? 'commander-memory.sqlite'
  }).listen(Number(process.env.PORT ?? 8785), '127.0.0.1')
}
