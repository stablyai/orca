import { describe, expect, it } from 'vitest'
import { RUNTIME_NAVIGATION_TARGETS } from '../../../../shared/runtime-navigation'
import { z } from 'zod'
import { BrowserPageCreationPlacement } from '../../../../shared/browser-client-host-placement'
import { BrowserTabCreateParams } from '../../../../shared/rpc-contract/browser-tab-create-params'
import { OptionalString } from '../../../../shared/rpc-contract/rpc-param-primitives'
import { getCompiledSchema } from '../../../zod-schema-compilation'

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

  it('keeps the joined tab optional for older clients and carries it when sent', () => {
    expect(BrowserTabCreateParams.parse({ worktree: 'id:worktree-a' }).browserTabId).toBeUndefined()
    expect(BrowserTabCreateParams.parse({ browserTabId: 'tab-1' }).browserTabId).toBe('tab-1')
  })
})

// The schema as an older host parses it: browser-tab-create-params.ts at 2366072dc81, before browserTabId.
const OldBrowserTabCreateParams = z.object({
  url: OptionalString,
  worktree: OptionalString,
  page: OptionalString,
  profileId: OptionalString,
  waitForRegistration: z.boolean().optional(),
  activate: z.boolean().optional(),
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
  targetGroupId: OptionalString,
  placement: BrowserPageCreationPlacement.optional()
})

describe('browser.tabCreate on a host older than browserTabId', () => {
  it('accepts a request naming a tab and drops the name, as its dispatcher parses it', () => {
    const parsed = getCompiledSchema(OldBrowserTabCreateParams).safeParse({
      worktree: 'id:worktree-a',
      url: 'https://example.com/',
      page: 'page-2',
      browserTabId: 'tab-1'
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({
      worktree: 'id:worktree-a',
      url: 'https://example.com/',
      page: 'page-2'
    })
  })
})
