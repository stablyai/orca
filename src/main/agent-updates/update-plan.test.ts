import { describe, expect, it } from 'vitest'
import { planAgentUpdate } from './update-plan'

describe('planAgentUpdate', () => {
  it('offers nothing on a platform no manual step supports', () => {
    const muse = {
      latest: {
        kind: 'json',
        url: 'https://api.meta.ai/muse-code/channels/muse-stable',
        field: 'version'
      },
      update: [
        {
          via: 'manual',
          command: 'curl -fsSL https://dev.meta.ai/install.sh | MUSE_UPGRADE_MODE=1 sh',
          platforms: ['darwin', 'linux']
        }
      ]
    } as const
    const resolved = {
      binary: 'C:\\Users\\dev\\.local\\bin\\muse.exe',
      installMethod: 'other'
    } as const

    expect(planAgentUpdate(muse, resolved, 'win32')).toBeNull()
  })

  it('offers no npm command as a hint for an install npm does not own', () => {
    const gemini = {
      latest: { kind: 'npm', pkg: '@google/gemini-cli' },
      update: [{ via: 'npm', pkg: '@google/gemini-cli' }]
    } as const
    const resolved = { binary: '/home/dev/.bun/bin/gemini', installMethod: 'other' } as const

    expect(planAgentUpdate(gemini, resolved, 'linux')).toBeNull()
  })
})
