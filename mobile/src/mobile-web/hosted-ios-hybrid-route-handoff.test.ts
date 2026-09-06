import { describe, expect, it, vi } from 'vitest'
import { openHostedIosHybridRoute } from '../../scripts/hosted-ios-hybrid-route-handoff.mjs'

describe('hosted iOS hybrid route handoff', () => {
  it('opens the production route without an Experimental Settings entry', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)

    await openHostedIosHybridRoute({ deviceUdid: 'simulator' }, 10_000, openUrl)

    expect(openUrl).toHaveBeenCalledWith('simulator', 'orca:///hybrid')
  })
})
