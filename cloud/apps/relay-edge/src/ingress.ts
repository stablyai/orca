// Front doors that are not Cloudflare. Two ways to be trusted; anything else is a direct request.
//  - Signed (our ingress proxy): `x-orca-ingress: v1 …` with an HMAC (relay-contract ingress-header.ts).
//  - Token (a cloud load balancer, which cannot compute a MAC): `x-orca-ingress: v1s <name> <origin>
//    <token>` plus `x-orca-client-ip` / `x-orca-client-country`, all set by the load balancer
//    (it overwrites same-named client headers). Trusted only when the token is one of
//    INGRESS_TOKENS, the origin is one of INGRESS_ORIGINS, AND cf-connecting-ip (the hop that
//    reached Cloudflare) is inside INGRESS_SOURCE_CIDRS, the load balancer's published egress
//    ranges, pinned in config (scripts/ingress-source-cidrs.ts refreshes and checks them).
//    Those ranges are shared by every customer's load balancers: the token is the discriminator.
//    A request from those ranges that fails the rule is refused (403, ingress_rejected) rather
//    than treated as direct, which would key pre-auth limits on the shared egress address.
import { INGRESS_HEADER, verifyIngressHeader, type IngressClaim } from '../../../packages/relay-contract/src/ingress-header'
import type { EdgeConfig } from './env'

export type Ingress = IngressClaim & { country?: string }
export type Cidr = { v6: boolean; base: bigint; bits: number }

const COUNTRY = /^[A-Z]{2}$/

export async function readIngress(config: EdgeConfig, request: Request): Promise<Ingress | null> {
  const header = request.headers.get(INGRESS_HEADER)
  if (!header) return null
  if (!header.startsWith('v1s ')) return verifyIngressHeader(header, config.ingressSecrets)
  const { tokens, origins, sourceCidrs } = config.ingressToken
  const parts = header.split(' ')
  if (tokens.length === 0 || parts.length !== 4) return null
  const [, name, origin, token] = parts as [string, string, string, string]
  if (!/^[a-z0-9-]{1,32}$/.test(name) || !origins.includes(origin)) return null
  if (!fromTokenSource(config, request)) return null
  if (!(await tokenMatches(tokens, token))) return null
  // Expanded by the load balancer; a missing value (empty) is refused rather than keyed on its egress.
  const clientIp = request.headers.get('x-orca-client-ip')?.trim() ?? ''
  if (!parseIp(clientIp)) return null
  const country = request.headers.get('x-orca-client-country')?.trim().toUpperCase() ?? ''
  return { name, origin, clientIp, ...(COUNTRY.test(country) ? { country } : {}) }
}

// The hop that reached Cloudflare is inside the token-mode front door's egress ranges. Those ranges
// are shared by every customer's load balancers, so this alone proves nothing; the token does.
export function fromTokenSource(config: EdgeConfig, request: Request): boolean {
  const { sourceCidrs } = config.ingressToken
  return sourceCidrs.length > 0 && inCidrs(request.headers.get('cf-connecting-ip') ?? '', sourceCidrs)
}

// Compares SHA-256 digests, so neither the length nor the content of a token leaks through timing.
// crypto.subtle.timingSafeEqual is the Workers runtime's; the loop is the same check elsewhere.
async function tokenMatches(tokens: readonly string[], presented: string): Promise<boolean> {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const mine = await digest(presented)
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean }
  let match = false
  for (const token of tokens) {
    const theirs = await digest(token)
    let equal: boolean
    if (subtle.timingSafeEqual) equal = subtle.timingSafeEqual(mine, theirs)
    else {
      let diff = 0
      for (let i = 0; i < mine.length; i++) diff |= mine[i]! ^ theirs[i]!
      equal = diff === 0
    }
    match ||= equal
  }
  return match
}

// IPv4 or IPv6 text → family and 32/128-bit value; null for anything else.
export function parseIp(text: string): { v6: boolean; value: bigint } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const octets = text.split('.').map(Number)
    if (octets.some((o) => o > 255)) return null
    return { v6: false, value: octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n) }
  }
  if (!/^[0-9a-fA-F:]{2,39}$/.test(text) || text.split('::').length > 2) return null
  const [head, tail] = text.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - left.length - right.length
  const groups = [...left, ...new Array<string>(Math.max(fill, 0)).fill('0'), ...right]
  if (groups.length !== 8 || (tail !== undefined && fill < 1) || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null
  return { v6: true, value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) }
}

export function parseCidr(text: string): Cidr | null {
  const [address, bitsText] = text.trim().split('/')
  const ip = parseIp(address ?? '')
  const width = ip?.v6 ? 128 : 32
  const bits = Number(bitsText)
  if (!ip || !/^\d{1,3}$/.test(bitsText ?? '') || bits > width) return null
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(width - bits)
  return { v6: ip.v6, base: ip.value & mask, bits }
}

export function inCidrs(text: string, cidrs: readonly Cidr[]): boolean {
  const ip = parseIp(text.trim())
  if (!ip) return false
  return cidrs.some((c) => {
    const width = c.v6 ? 128 : 32
    return c.v6 === ip.v6 && ip.value >> BigInt(width - c.bits) === c.base >> BigInt(width - c.bits)
  })
}
