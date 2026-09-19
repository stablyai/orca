import { describe, expect, it } from 'vitest'
import {
  callsRouteHandoff,
  importsExpoRouterValue,
  parse,
  productFiles
} from '../navigation/router-seam-census.test-support'

const FILES_ROOT = import.meta.dirname

/**
 * Which modules here hold a router, so the census cannot pass by seeing nothing.
 *
 * The walk and the two rules are the seam's, shared with every other domain that runs them; what
 * stays here is this domain's own evidence: which of its modules are meant to hold a router.
 */
const ROUTER_HOLDERS = ['MobileFilePreviewScreen.tsx', 'MobileFileExplorerPanel.tsx']

describe('the files domain reaches the router through the handoff seam', () => {
  const files = productFiles(FILES_ROOT)

  it('walks the modules it is written against', () => {
    expect(files).toEqual(expect.arrayContaining(ROUTER_HOLDERS))
  })

  it('imports no router from expo-router, which the page cannot hand a route back through', () => {
    expect(files.filter((name) => importsExpoRouterValue(parse(FILES_ROOT, name)))).toEqual([])
  })

  it('takes the router from useRouteHandoff at every screen that holds one', () => {
    expect(files.filter((name) => callsRouteHandoff(parse(FILES_ROOT, name))).sort()).toEqual(
      [...ROUTER_HOLDERS].sort()
    )
  })
})
