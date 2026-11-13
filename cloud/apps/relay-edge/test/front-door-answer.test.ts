import { describe, expect, it } from 'vitest'
import { classify } from './front-door-answer'

const cf = { server: 'cloudflare', 'cf-ray': 'x' }
const a = (status: number, headers: Record<string, string> = cf, body = '') => ({ status, headers, body, ms: 1 })

describe('G4 answer classification', () => {
  it('keeps our refusals apart from the zone and the load balancer', () => {
    expect(classify(a(101, {}))).toBe('upgraded')
    expect(classify(a(426))).toBe('edge')
    expect(classify(a(401))).toBe('edge')
    expect(classify(a(200, cf, '{"ok":true}'))).toBe('edge')
    expect(classify(a(429))).toBe('edge-preauth-limiter')
    expect(classify(a(403, { ...cf, 'cf-mitigated': 'challenge' }, '<html>'))).toBe('cf-zone')
    expect(classify(a(429, cf, 'error code: 1015'))).toBe('cf-zone')
    expect(classify(a(403, cf, '<title>Attention Required! | Cloudflare</title>'))).toBe('cf-zone')
    expect(classify(a(502, { via: '1.1 google' }, 'Error: Server Error'))).toBe('load-balancer')
    expect(classify(a(-1, {}))).toBe('network')
    expect(classify(a(500))).toBe('other')
    expect(classify(a(426, {}), '')).toBe('edge')
  })
})
