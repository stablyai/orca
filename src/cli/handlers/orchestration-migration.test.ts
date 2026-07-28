import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration CLI migration recovery', () => {
  it('redirects worker_done without an outcome before resolving or calling the runtime', async () => {
    const call = vi.fn()

    await expect(
      ORCHESTRATION_HANDLERS['orchestration send']({
        flags: new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['subject', 'Done'],
          ['type', 'worker_done']
        ]),
        client: { call },
        cwd: '/tmp/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      data: {
        effectsApplied: false,
        nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
      }
    })
    expect(call).not.toHaveBeenCalled()
  })
})
