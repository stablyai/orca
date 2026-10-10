import { describe, expect, it } from 'vitest'
import { RUNTIME_NAVIGATION_TARGETS } from '../../../../shared/runtime-navigation'
import { BrowserTabCreateParams } from './browser-tab-create-schema'

describe('browser.tabCreate placement schema', () => {
  it('keeps placement optional for older clients', () => {
    expect(BrowserTabCreateParams.parse({ worktree: 'id:worktree-a' })).not.toHaveProperty(
      'placement'
    )
  })

  it.each([
    { kind: 'server' as const },
    { kind: 'client' as const, browserHostClientId: 'browser-client-a' }
  ])('accepts additive explicit $kind placement', (placement) => {
    expect(BrowserTabCreateParams.parse({ placement })).toMatchObject({ placement })
  })

  it('rejects malformed client placement identity', () => {
    expect(() =>
      BrowserTabCreateParams.parse({ placement: { kind: 'client', browserHostClientId: '' } })
    ).toThrow()
  })

  it('keeps navigation optional so a client that predates it still parses', () => {
    expect(BrowserTabCreateParams.parse({ worktree: 'id:worktree-a' })).not.toHaveProperty(
      'navigation'
    )
  })

  it.each(RUNTIME_NAVIGATION_TARGETS)('accepts the additive %s navigation target', (navigation) => {
    expect(BrowserTabCreateParams.parse({ navigation })).toMatchObject({ navigation })
  })

  it('rejects a navigation target the host does not define', () => {
    expect(() => BrowserTabCreateParams.parse({ navigation: 'others' })).toThrow()
  })
})
