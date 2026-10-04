import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createPageBackConsumers,
  type PageBackConsumers
} from '../mobile-web-shell/bridge/page-back-consumers'

/** The document this hook claims into: the real stack, and what it said. */
type PageBackProbe = {
  claims: boolean[]
  unclaimed: Mock
  /** Null stands for a tree outside the page's provider, which has no stack at all. */
  consumers: PageBackConsumers | null
}

// Built in `beforeEach` rather than at `vi.hoisted`, which runs before this file's own imports:
// the real stack is what the hook is measured against, and a fake answering its edges would be a
// second copy of the rule.
const page = vi.hoisted((): PageBackProbe => ({ claims: [], unclaimed: vi.fn(), consumers: null }))

vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () =>
    page.consumers === null ? null : { claimBack: (claim: () => boolean) => stack().claim(claim) }
}))

import { useBackClaim } from './use-back-claim.web'

function stack(): PageBackConsumers {
  if (page.consumers === null) {
    throw new Error('the page back stack was not built for this case')
  }
  return page.consumers
}

function Screen({ claim }: { claim: (() => boolean) | null }): null {
  useBackClaim(claim)
  return null
}

function render(claim: (() => boolean) | null): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(createElement(Screen, { claim }))
  })
  return tree
}

beforeEach(() => {
  page.claims.length = 0
  page.unclaimed.mockClear()
  page.consumers = createPageBackConsumers({
    publishClaim: (claimed) => page.claims.push(claimed),
    onUnclaimed: page.unclaimed
  })
})

/**
 * The page half of the seam every sheet takes. There is no hardware key inside a WebView:
 * react-native-web answers `BackHandler.addEventListener` with a console warning and an inert
 * subscription, so the page claims the shell's key over the bridge instead.
 */
describe('a page screen claiming the device Back key from the shell', () => {
  it('claims nothing while the caller has nothing to do with the key', () => {
    render(null)
    expect(page.claims).toEqual([])
  })

  /**
   * `MountedBottomDrawer` is shared with the native app and renders under no page provider in a
   * bare mount. Throwing for want of a shell would take the screen down; there is simply no key to
   * claim, so nothing is claimed.
   */
  it('claims nothing, and does not throw, outside the page bridge', () => {
    page.consumers = null
    expect(() => render(() => true)).not.toThrow()
    expect(page.claims).toEqual([])
  })

  it('claims while the caller holds it, and lets go when it stops', () => {
    const tree = render(() => true)
    expect(page.claims).toEqual([true])
    act(() => {
      tree.update(createElement(Screen, { claim: null }))
    })
    expect(page.claims).toEqual([true, false])
  })

  it('lets go when the screen unmounts, which is a sheet taken off the page', () => {
    const tree = render(() => true)
    act(() => tree.unmount())
    expect(page.claims).toEqual([true, false])
  })

  it('claims once across a rebuilt handler, and the newest one is what answers', () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    const tree = render(first)
    act(() => {
      tree.update(createElement(Screen, { claim: second }))
    })
    // One edge, so the shell heard one claim: a caller that rebuilds its handler every render must
    // not post a frame per render.
    expect(page.claims).toEqual([true])
    stack().press()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('hands a press on, which is what lets the one beneath it answer', () => {
    const under = vi.fn(() => true)
    const over = vi.fn(() => false)
    render(under)
    const tree = render(over)
    stack().press()
    expect(over).toHaveBeenCalledTimes(1)
    expect(under).toHaveBeenCalledTimes(1)
    expect(page.unclaimed).not.toHaveBeenCalled()
    act(() => tree.unmount())
  })
})
