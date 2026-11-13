import { describe, expect, it } from 'vitest'
import { homeFeedLayout } from './home-feed-layout'

const enrollment = {
  controlPlaneUrl: 'https://cp.example',
  deviceSessionId: 'ds_1',
  label: 'iPhone',
  enrolledAt: 1
}

describe('homeFeedLayout', () => {
  it('waits for the host catalog', () => {
    expect(homeFeedLayout({ hostCatalogLoaded: false, hostCount: 0, enrollment })).toBe('loading')
  })

  it('shows the feed whenever a host is paired', () => {
    expect(homeFeedLayout({ hostCatalogLoaded: true, hostCount: 1, enrollment: null })).toBe('feed')
  })

  it('keeps the Cloud section for an enrolled phone with no desktop paired', () => {
    expect(homeFeedLayout({ hostCatalogLoaded: true, hostCount: 0, enrollment })).toBe('feed')
  })

  it('shows the pairing empty state only to a phone with neither', () => {
    expect(homeFeedLayout({ hostCatalogLoaded: true, hostCount: 0, enrollment: null })).toBe(
      'pair-desktop'
    )
    expect(homeFeedLayout({ hostCatalogLoaded: true, hostCount: 0, enrollment: undefined })).toBe(
      'loading'
    )
  })
})
