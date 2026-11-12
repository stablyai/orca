import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { parseArgs } from '../args'
import { TERMINAL_HANDLERS } from './terminal'

afterEach(() => vi.restoreAllMocks())

describe('terminal set-pane-title', () => {
  it.each([{ args: [] }, { args: ['--title'] }])(
    'refuses a missing title before resolving a terminal (%j)',
    async ({ args }) => {
      const client = new RuntimeClient()
      const call = vi.spyOn(client, 'call')
      const parsed = parseArgs(['terminal', 'set-pane-title', ...args])
      await expect(
        TERMINAL_HANDLERS['terminal set-pane-title']({
          flags: parsed.flags,
          client,
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )
})
