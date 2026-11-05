import { describe, expect, it } from 'vitest'
import { admitProviderReattachLaunchIdentity } from './launch-authority'

describe('admitProviderReattachLaunchIdentity', () => {
  it('binds provider launch identity to a valid reattach incarnation', () => {
    expect(
      admitProviderReattachLaunchIdentity({
        isReattach: true,
        launchAgent: 'codex',
        incarnationId: 'provider-incarnation'
      })
    ).toEqual({ launchAgent: 'codex', incarnationId: 'provider-incarnation' })
  })

  it.each([
    { label: 'fresh spawn', isReattach: false, launchAgent: 'codex', incarnationId: 'incarnation' },
    {
      label: 'invalid agent',
      isReattach: true,
      launchAgent: 'unknown',
      incarnationId: 'incarnation'
    },
    {
      label: 'missing incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: undefined
    },
    {
      label: 'oversized incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: 'x'.repeat(129)
    }
  ])('rejects $label metadata', ({ isReattach, launchAgent, incarnationId }) => {
    expect(
      admitProviderReattachLaunchIdentity({ isReattach, launchAgent, incarnationId })
    ).toBeNull()
  })
})
