// Limits on sockets that have not authenticated yet (phone connects, host data sockets). Desktops
// authenticate with a relay JWT before the upgrade; phones and data sockets prove a credential in
// their first frame, so until then they are only bounded here.
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import type { Env } from './env'
import { metric, requestPlace } from './metrics'

// The caller's address as Cloudflare saw it (clients cannot set this header). IPv6 callers are
// keyed by their /64, which one subscriber usually holds whole.
export function sourceKey(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  if (!ip.includes(':')) return ip || 'unknown'
  const [head, tail = ''] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = ip.includes('::') && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':') + '::/64'
}

// Counted per source per colo by the Rate Limiting binding. Fails open: a limiter outage must not
// refuse live users. Without a binding (local spike runs) nothing is limited.
export async function admitPreAuth(env: Env, request: Request, kind: 'phone' | 'data'): Promise<boolean> {
  if (!env.PREAUTH_LIMITER) return true
  try {
    const { success } = await env.PREAUTH_LIMITER.limit({ key: `${kind}:${sourceKey(request)}` })
    if (!success) metric(env, 'preauth_limited', 1, kind, [], '', requestPlace(request))
    return success
  } catch {
    return true
  }
}

// A phone dialled the edge for a host the director never pushed (or one already wiped): answer
// from the Worker without creating any object storage. WRONG_CELL sends the phone back to the
// director, as a cell does for a host it does not hold; it never reads as a revoked credential.
export function notOnEdge(): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.accept()
  const timer = setTimeout(() => {
    try {
      server.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    } catch {}
  }, RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs)
  server.addEventListener(
    'message',
    () => {
      clearTimeout(timer)
      try {
        server.send(JSON.stringify({ type: 'relay-hello', ok: false, code: RELAY_CLOSE_CODE.WRONG_CELL }))
        server.close(RELAY_CLOSE_CODE.WRONG_CELL, 'host not on this cell')
      } catch {}
    },
    { once: true }
  )
  server.addEventListener('close', () => clearTimeout(timer))
  return new Response(null, { status: 101, webSocket: client })
}
