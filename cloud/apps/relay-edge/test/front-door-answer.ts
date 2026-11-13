// G4: who answered a handshake through the front door. Our Worker answers its refusals with an
// empty body (index.ts reject()); Cloudflare's zone features (bot fight mode, security level,
// rate/custom rules) set `cf-mitigated` or serve an HTML error page; the load balancer's own errors
// come without the edge's `server` header.
export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string; ms: number }
export type Source = 'upgraded' | 'edge' | 'edge-preauth-limiter' | 'cf-zone' | 'load-balancer' | 'network' | 'other'

export function classify(a: Answer, edgeServer = 'cloudflare'): Source {
  if (a.status === 101) return 'upgraded'
  if (a.status < 0) return 'network'
  if (a.headers['cf-mitigated'] !== undefined) return 'cf-zone'
  if (/error code: 1\d{3}|cf-error|challenge-platform|cf-chl|Just a moment|Attention Required|Sorry, you have been blocked/i.test(a.body)) return 'cf-zone'
  if (String(a.headers.server ?? '').toLowerCase() !== edgeServer) return 'load-balancer'
  if (a.status === 429 && a.body === '') return 'edge-preauth-limiter'
  if (a.status === 200 || ([400, 401, 404, 426].includes(a.status) && a.body === '')) return 'edge'
  return 'other'
}
