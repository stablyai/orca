import { describe, expect, it } from 'vitest'
import { readySession, run } from './mobile-web-shell-session-test-fixtures'
import { shellPageBackClaimed } from './shell-page-back-claim'
import type { MobileWebShellStep } from './mobile-web-shell-session-contract'

// Exercise every document reset: stale Back claims must never route a press to a page that no longer holds it.
describe('the page claiming the device Back key', () => {
  function claimed(): MobileWebShellStep {
    return run(
      readySession().session,
      { type: 'page-ready' },
      { type: 'page-back-claim', claimed: true }
    )
  }

  it('drops it when a replacement document starts inside this mount', () => {
    expect(shellPageBackClaimed(run(claimed().session, { type: 'document-started' }).session)).toBe(
      false
    )
  })

  it('records nothing from a page whose generation is no longer on screen', () => {
    const failed = run(claimed().session, { type: 'shell-failed', reason: 'isolation-unavailable' })
    const late = run(failed.session, { type: 'page-back-claim', claimed: true })
    expect(shellPageBackClaimed(late.session)).toBe(false)
  })
})
