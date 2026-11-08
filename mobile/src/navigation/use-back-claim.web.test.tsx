import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createPageBackConsumers,
  type PageBackConsumers
} from '../mobile-web-shell/bridge/page-back-consumers'

type PageBackProbe = {
  claims: boolean[]
  unclaimed: Mock
  consumers: PageBackConsumers | null
}

// Build the real stack after imports, not inside vi.hoisted, so no fake duplicates the behavior under test.
const page = vi.hoisted((): PageBackProbe => ({ claims: [], unclaimed: vi.fn(), consumers: null }))

vi.mock('../transport/connection/client-context.web', () => ({
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

const trees: ReactTestRenderer[] = []

function render(claim: (() => boolean) | null): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(createElement(Screen, { claim }))
  })
  trees.push(tree)
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

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
  page.consumers = null
})

// RN Web BackHandler is inert, so sheets must claim the shell’s key through the bridge.
describe('a page screen claiming the device Back key from the shell', () => {
  // Shared drawers can mount without a page provider; no available shell means no claim, never a thrown render.
  it('claims nothing, and does not throw, outside the page bridge', () => {
    page.consumers = null
    expect(() => render(() => true)).not.toThrow()
    expect(page.claims).toEqual([])
  })
})
