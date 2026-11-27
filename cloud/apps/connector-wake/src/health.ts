// GET /__health/object: the alerts Worker's deep probe. Unauthenticated and side-effect free: it
// calls one fixed canary ConnectorHost object, which answers without touching storage. 200
// {ok:true}, or 503 {ok:false} on any failure or after OBJECT_HEALTH_TIMEOUT_MS. Bounded per source
// per colo by PREAUTH_LIMITER (429, its own 'health:' key). The canary holds no host's socket.
import type { Env } from './env'
import { admitPreAuth } from './preauth'
import { hostObjectName } from './host-id'

// 'health' is shorter than any mid (16-64 chars), so the canary is never a host.
export const HEALTH_CANARY_OBJECT = 'canary:health'
export const OBJECT_HEALTH_TIMEOUT_MS = 3_000

async function canaryAnswers(env: Env): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), OBJECT_HEALTH_TIMEOUT_MS)
  })
  try {
    const stub = env.CONNECTOR_HOST.get(env.CONNECTOR_HOST.idFromName(hostObjectName(HEALTH_CANARY_OBJECT)))
    const check = stub.healthCheck().then(
      (result) => result.ok === true,
      () => false
    )
    return await Promise.race([check, timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function objectHealth(env: Env, request: Request): Promise<Response> {
  if (request.method !== 'GET') { return new Response(null, { status: 405 }) }
  if (!(await admitPreAuth(env, request, 'health'))) { return new Response(null, { status: 429 }) }
  const ok = await canaryAnswers(env)
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } })
}
