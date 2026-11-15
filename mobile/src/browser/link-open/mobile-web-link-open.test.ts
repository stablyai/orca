import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openExternalLink } from '../../platform/external-links/external-link'
import { openMobileWebLink } from './mobile-web-link-open'

vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink: vi.fn() }))

const url = 'https://example.com/pr/1'

describe('openMobileWebLink', () => {
  const openInOrca = vi.fn()
  const ask = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('asks instead of opening anything in ask mode', () => {
    openMobileWebLink(url, 'ask', openInOrca, ask)
    expect(ask).toHaveBeenCalledWith(url)
    expect(openInOrca).not.toHaveBeenCalled()
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('opens an Orca browser tab directly when one can open', () => {
    openMobileWebLink(url, 'orca-browser', openInOrca, ask)
    expect(openInOrca).toHaveBeenCalledWith(url)
    expect(openExternalLink).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('falls back to the phone browser where no Orca browser tab can open', () => {
    openMobileWebLink(url, 'orca-browser', undefined, ask)
    expect(openExternalLink).toHaveBeenCalledWith(url)
    expect(ask).not.toHaveBeenCalled()
  })

  it('opens the phone browser directly in phone-browser mode', () => {
    openMobileWebLink(url, 'phone-browser', openInOrca, ask)
    expect(openExternalLink).toHaveBeenCalledWith(url)
    expect(openInOrca).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })
})
