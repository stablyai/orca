import { describe, expect, it } from 'vitest'
import {
  callsRouteHandoff,
  importsExpoRouterValue,
  parse,
  productFiles
} from '../navigation/router-seam-census.test-support'

const SOURCE_CONTROL_ROOT = import.meta.dirname

/**
 * Which modules here hold a router, so the census cannot pass by seeing nothing.
 *
 * One holder, not one per screen: the hub's router is taken once in the openers hook and passed
 * down through the state hook to the runners and the panel. So this domain's whole reach into the
 * router is that single call, and the rules below say so rather than counting screens.
 *
 * `use-mobile-source-control-runners.ts` is the case a value/type rule is written for: it named
 * expo-router only to write `ReturnType<typeof useRouter>`, which is a value import in a type
 * position and keeps the module in the graph. `RouteHandoff` is the seam's own name for that type.
 */
const ROUTER_HOLDERS = ['use-mobile-source-control-openers.ts']

describe('the source-control domain reaches the router through the handoff seam', () => {
  const files = productFiles(SOURCE_CONTROL_ROOT)

  it('walks the modules it is written against', () => {
    expect(files).toEqual(expect.arrayContaining(ROUTER_HOLDERS))
    expect(files).toContain('use-mobile-source-control-runners.ts')
    expect(files).toContain('MobileSourceControlPanel.tsx')
  })

  it('imports no router from expo-router, which the page cannot hand a route back through', () => {
    expect(
      files.filter((name) => importsExpoRouterValue(parse(SOURCE_CONTROL_ROOT, name)))
    ).toEqual([])
  })

  it('takes the router from useRouteHandoff at every screen that holds one', () => {
    expect(
      files.filter((name) => callsRouteHandoff(parse(SOURCE_CONTROL_ROOT, name))).sort()
    ).toEqual([...ROUTER_HOLDERS].sort())
  })
})
