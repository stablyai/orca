import { describe, expect, it, vi } from 'vitest'

import { removeHostAndCloseClient } from './host-removal-lifecycle.web'
import { isPageHostRemovalUnavailable } from './page-host-removal-refusal'

describe('removing a host from the page', () => {
  it('refuses with a code the screen can branch on', async () => {
    const error = await removeHostAndCloseClient('host-1', vi.fn()).catch(
      (reason: unknown) => reason
    )
    expect(isPageHostRemovalUnavailable(error)).toBe(true)
    expect({
      name: error instanceof Error ? error.name : null,
      code: isPageHostRemovalUnavailable(error) ? error.code : null
    }).toEqual({
      name: 'PageHostRemovalUnavailableError',
      code: 'page_host_removal_unavailable'
    })
  })
})
