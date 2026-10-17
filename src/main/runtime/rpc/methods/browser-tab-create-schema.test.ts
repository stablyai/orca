import { describe, expect, it } from 'vitest'
import { RUNTIME_NAVIGATION_TARGETS } from '../../../../shared/runtime-navigation'
import { BrowserTabCreateParams } from '../../../../shared/rpc-contract/browser-tab-create-params'
import { BROWSER_TAB_SPLIT_DIRECTIONS } from '../../../../shared/browser-tab-split-direction'

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

  it('keeps split optional so a plain create still parses', () => {
    expect(BrowserTabCreateParams.parse({ worktree: 'id:worktree-a' })).not.toHaveProperty('split')
  })

  it.each(BROWSER_TAB_SPLIT_DIRECTIONS)('accepts the %s split direction', (split) => {
    expect(BrowserTabCreateParams.parse({ split, splitFromTabId: 'tab-1' })).toMatchObject({
      split,
      splitFromTabId: 'tab-1'
    })
  })

  it('rejects a split direction the renderer cannot build', () => {
    expect(() => BrowserTabCreateParams.parse({ split: 'horizontal' })).toThrow()
  })
})
