import { beforeEach, describe, expect, it } from 'vitest'
import { trustedRendererRegistry } from './trusted-renderer-registry'

describe('trustedRendererRegistry', () => {
  beforeEach(() => {
    trustedRendererRegistry.clearWebContents(17)
    trustedRendererRegistry.clearWebContents(18)
  })

  it('grants, revokes, and checks capabilities independently', () => {
    trustedRendererRegistry.grant(17, 'ui')

    expect(trustedRendererRegistry.has(17, 'ui')).toBe(true)
    expect(trustedRendererRegistry.has(17, 'clipboard')).toBe(false)
    expect(trustedRendererRegistry.has(17, 'pty')).toBe(false)
    expect(trustedRendererRegistry.has(17, 'browser')).toBe(false)

    trustedRendererRegistry.grantMany(17, ['clipboard', 'pty'])
    expect(trustedRendererRegistry.has(17, 'clipboard')).toBe(true)
    expect(trustedRendererRegistry.has(17, 'pty')).toBe(true)
    expect(trustedRendererRegistry.has(17, 'browser')).toBe(false)

    trustedRendererRegistry.revoke(17, 'clipboard')
    expect(trustedRendererRegistry.has(17, 'ui')).toBe(true)
    expect(trustedRendererRegistry.has(17, 'clipboard')).toBe(false)

    trustedRendererRegistry.revoke(17)
    expect(trustedRendererRegistry.has(17, 'ui')).toBe(false)
    expect(trustedRendererRegistry.has(17, 'pty')).toBe(false)
  })

  it('clears one webContents without affecting another', () => {
    trustedRendererRegistry.grantMany(17, ['ui', 'clipboard'])
    trustedRendererRegistry.grant(18, 'browser')

    trustedRendererRegistry.clearWebContents(17)

    expect(trustedRendererRegistry.has(17, 'ui')).toBe(false)
    expect(trustedRendererRegistry.has(18, 'browser')).toBe(true)
  })
})
