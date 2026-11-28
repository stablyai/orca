import { describe, expect, it } from 'vitest'
import { pageSideStripRoom, type SideStripPageView } from './side-strip-holder'

const HOST_AREA_GRANTS = ['navigate', 'storage', 'terminalKeyRail', 'sideStripCover']
const BASE = { free: null, keyRailClaimed: false } satisfies Partial<SideStripPageView>

describe('pageSideStripRoom', () => {
  it('gives the strip to a worker session the host page opened, whatever location it reported', () => {
    // A bot's worker session opens standalone inside the host document.
    const worker = {
      ...BASE,
      ownsHostArea: true,
      routeGrants: HOST_AREA_GRANTS,
      location: '/h/mac/session/repo%3A%3A%2Fwt%2Ffork-split?standalone=1'
    }
    expect(pageSideStripRoom({ ...worker, covered: true }).kind).toBe('none')
    expect(pageSideStripRoom({ ...worker, location: '/h/mac', covered: true }).kind).toBe('none')
    expect(pageSideStripRoom({ ...worker, location: null, covered: true }).kind).toBe('none')
    // Pages that predate the cover report fall back to the session location.
    expect(pageSideStripRoom({ ...worker, covered: null }).kind).toBe('none')
  })

  it('leaves the strip to the rings on the host list despite its union of route grants', () => {
    const hostList = {
      ...BASE,
      ownsHostArea: true,
      routeGrants: HOST_AREA_GRANTS,
      location: '/h/mac'
    }
    expect(pageSideStripRoom({ ...hostList, covered: false }).kind).toBe('whole')
    expect(pageSideStripRoom({ ...hostList, covered: null }).kind).toBe('whole')
  })

  it('keeps the strip for a session route unless its page names an empty span', () => {
    const session = {
      ...BASE,
      ownsHostArea: false,
      routeGrants: ['terminalKeyRail'],
      location: null
    }
    expect(pageSideStripRoom({ ...session, covered: false }).kind).toBe('none')
    expect(pageSideStripRoom({ ...session, covered: true }).kind).toBe('none')
    const free = { top: 120, bottom: 500 }
    expect(pageSideStripRoom({ ...session, covered: true, free })).toEqual({
      kind: 'span',
      ...free
    })
    // The terminal's key rail always wins the strip.
    expect(pageSideStripRoom({ ...session, covered: true, free, keyRailClaimed: true }).kind).toBe(
      'none'
    )
  })
})
