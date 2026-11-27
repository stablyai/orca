// Limits on requests that have not authenticated yet: the wake upgrade (before its token is
// checked) and the unauthenticated object health probe (health.ts). Copied from the edge.
import type { Env } from './env'
import { metric, requestPlace } from './metrics'

// The caller's address as Cloudflare saw it (clients cannot set this header). IPv6 callers are
// keyed by their /64, which one subscriber usually holds whole.
export function sourceKey(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  if (!ip.includes(':')) { return ip || 'unknown' }
  const [head, tail = ''] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = ip.includes('::') && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

// Counted per source per colo by the Rate Limiting binding. Fails open: a limiter outage must not
// refuse live users. Without a binding (local runs) nothing is limited.
export async function admitPreAuth(env: Env, request: Request, kind: 'wake' | 'health'): Promise<boolean> {
  if (!env.PREAUTH_LIMITER) { return true }
  try {
    const { success } = await env.PREAUTH_LIMITER.limit({ key: `${kind}:${sourceKey(request)}` })
    if (!success) { metric(env, 'preauth_limited', 1, kind, [], '', requestPlace(request)) }
    return success
  } catch {
    return true
  }
}
