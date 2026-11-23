import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternalLink = vi.fn()
vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink }))

const { openMobileWebLink } = await import('./mobile-web-link-open')

describe('openMobileWebLink', () => {
  const openInOrca = vi.fn()
  const ask = vi.fn()
  beforeEach(() => vi.clearAllMocks())

  it('opens a loopback link in the host browser even when links open on the phone', () => {
    openMobileWebLink('http://127.0.0.1:3000/', 'phone-browser', openInOrca, ask)

    expect(openInOrca).toHaveBeenCalledWith('http://127.0.0.1:3000/')
    expect(openExternalLink).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })
})
