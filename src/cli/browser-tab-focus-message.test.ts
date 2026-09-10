import { describe, expect, it, vi } from 'vitest'
import { BROWSER_TAB_HANDLERS } from './handlers/browser-tab'
import { okFixture } from './test-fixtures'

// `tab create` reads a `focus` flag that the command spec does not yet expose, so drive the
// handler directly rather than widening the CLI contract just to observe its reporting.
async function focusedCreateOutput(nativePanePaint: string, observedAt: string | null) {
  const flags = new Map<string, string | boolean>([
    ['url', 'https://example.com'],
    ['worktree', 'all'],
    ['focus', true]
  ])
  const client = {
    call: async () =>
      okFixture('req_create', {
        browserPageId: 'page-1',
        focusReceipt: { requested: true, exactPageSelected: true, nativePanePaint, observedAt }
      })
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await BROWSER_TAB_HANDLERS['tab create']({ flags, client, cwd: '/tmp', json: false } as never)
  const output = log.mock.calls.map((call) => String(call[0])).join('\n')
  log.mockRestore()
  return output
}

describe('orca cli browser tab focus reporting', () => {
  it('separates a painted pane from a blank one and from one never observed', async () => {
    expect(await focusedCreateOutput('painted', '2026-08-25T12:00:00.000Z')).toContain(
      'Created and focused tab page-1'
    )

    expect(await focusedCreateOutput('unpainted', '2026-08-25T12:00:00.000Z')).toContain(
      'the native pane produced no paint'
    )

    // An unobserved probe must never be reported as if the pane had been seen blank.
    const unobserved = await focusedCreateOutput('unobserved', null)
    expect(unobserved).toContain('native pane paint was not observed')
    expect(unobserved).not.toContain('produced no paint')
  })
})
